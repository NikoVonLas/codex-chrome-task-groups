import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Persistent STDIO client for an already-running agent whose native tool catalog
// predates registration of chrome-cli. Uses the same approved registered launcher.
// Authentication remains inside the MCP runtime; this client never reads tokens.
export async function connectChrome({workspace, launcher, launcherArgs = [], env = {}, clientName = 'Codex CLI live session', shutdownTimeoutMs = 6000} = {}) {
  if (!workspace) throw new Error('A workspace root is required');
  const child = spawn(launcher, launcherArgs, {cwd: resolve(workspace), env: {...process.env, ...env}, stdio: ['pipe', 'pipe', 'pipe']});
  let buffer = '', nextId = 0, stopped = false;
  const pending = new Map();
  const send = message => child.stdin.write(JSON.stringify({jsonrpc: '2.0', ...message}) + '\n');
  const fail = error => {
    stopped = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  child.stderr.resume(); // Never forward logs that could contain browser/session data.
  child.on('error', () => fail(new Error('Could not start the configured Chrome MCP')));
  child.on('exit', () => fail(new Error('Chrome MCP disconnected')));
  child.stdout.on('data', data => {
    buffer += data;
    while (buffer.includes('\n')) {
      const split = buffer.indexOf('\n'), line = buffer.slice(0, split);
      buffer = buffer.slice(split + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { fail(new Error('Invalid MCP response')); child.kill(); return; }
      if (message.method === 'roots/list') {
        send({id: message.id, result: {roots: [{uri: pathToFileURL(resolve(workspace)).href, name: 'Codex workspace'}]}});
      } else if (message.method === 'ping') send({id: message.id, result: {}});
      else if (message.method && message.id !== undefined) {
        send({id: message.id, error: {code: -32601, message: 'Unsupported client method'}});
      } else if (pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id); clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
      }
    }
  });
  const request = (method, params, timeout = 180000) => new Promise((resolve, reject) => {
    if (stopped) { reject(new Error('Chrome MCP is disconnected')); return; }
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, timeout);
    pending.set(id, {resolve, reject, timer});
    send({id, method, params});
  });
  const close = async () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.stdin.end(); child.kill();
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, shutdownTimeoutMs);
    await exited; clearTimeout(timer);
  };
  try {
    const initialized = await request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {roots: {listChanged: false}},
      clientInfo: {name: clientName, version: '1.0.0'}
    }, 20000);
    send({method: 'notifications/initialized'});
    const listed = await request('tools/list', {}, 20000);
    const available = listed.tools.filter(tool => tool.name !== 'browser_run_code_unsafe');
    const names = new Set(available.map(tool => tool.name));
    let browserUsed = false;
    return {
      server: initialized.serverInfo,
      tools: available,
      disconnect: close,
      async call(name, args = {}) {
        if (!names.has(name)) throw new Error(`Tool not enabled: ${name}`);
        if (name.startsWith('browser_') && name !== 'browser_finish') browserUsed = true;
        const result = await request('tools/call', {name, arguments: args});
        if (name === 'browser_finish' && !result.isError) browserUsed = false;
        return result;
      },
      async close() {
        if (browserUsed && names.has('browser_finish') && !stopped) {
          await request('tools/call', {name: 'browser_finish', arguments: {}}, 10000).catch(() => {});
        }
        await close();
      }
    };
  } catch (error) {
    await close();
    throw error;
  }
}
