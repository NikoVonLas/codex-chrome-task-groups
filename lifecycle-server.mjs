import {createInterface} from 'node:readline';
import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {connectChrome} from './client.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(homedir(), '.codex-chrome-task-groups');
const tokenFile = resolve(dataDir, 'extension-token');
const token = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN || (existsSync(tokenFile) && readFileSync(tokenFile, 'utf8').trim());
const automatic = Boolean(token);
const backendOptions = {
  workspace: process.cwd(),
  launcher: process.execPath,
  launcherArgs: [
    '--require', resolve(root, 'parent-lifetime.cjs'), resolve(root, 'node_modules/@playwright/mcp/cli.js'),
    '--extension', '--background', '--browser', 'chrome', '--profile-dir-name', process.env.CHROME_PROFILE_DIR || 'Default',
    '--caps', 'vision', '--snapshot-boxes', '--no-webmcp', '--codegen', 'none',
    '--redact-url-params', 'access_token,token,code,password,secret,api_key', '--output-dir', resolve(dataDir, 'output'),
    ...process.argv.slice(2)
  ],
  env: token ? {PLAYWRIGHT_MCP_EXTENSION_TOKEN: token} : {},
  shutdownTimeoutMs: 2000
};
const idleMs = Number(process.env.CODEX_CHROME_IDLE_MS ?? 120000);
if (!Number.isFinite(idleMs) || idleMs < 100) throw new Error('Invalid idle cleanup interval');
let backend = await connectChrome(backendOptions);
let taskTitle = null;
const startTool = {
  name: 'browser_start_task', title: 'Start a named browser task',
  description: 'Call before browser work. Creates a separate task session whose Chrome tab group includes the supplied task name. Finishes the previous task first. Requires the local task-group extension. Never include credentials in the title.',
  inputSchema: {type: 'object', properties: {task: {type: 'string', minLength: 1, maxLength: 80, description: 'Short human-readable task name'}}, required: ['task'], additionalProperties: false}
};
async function startTask(args) {
  if (!args || Object.keys(args).some(key => key !== 'task') || typeof args.task !== 'string') throw new Error('A task name is required');
  const title = args.task.trim();
  if (!title || title.length > 80 || /[\x00-\x1f\x7f]/.test(title)) throw new Error('Task name must be 1–80 characters without control characters');
  if (!automatic) throw new Error('Set up the local extension token as described in README.md before starting a task');
  const cleaned = await cleanup('new task');
  if (cleaned.isError) return cleaned;
  await backend.close();
  backend = await connectChrome({...backendOptions, clientName: title});
  taskTitle = title;
  return result({task: title, ready: true});
}
const finishTool = {
  name: 'browser_finish', title: 'Finish task and remove its tab group',
  description: 'Call when browser work for the current task is complete. Closes the temporary tabs controlled by this MCP session, including its connection page; the local extension ungroups them before closing to remove the temporary group. Other Chrome tabs and other MCP sessions are preserved. Do not leave task tabs open after reporting completion.',
  inputSchema: {type: 'object', properties: {}, additionalProperties: false}
};
const names = new Set(backend.tools.map(tool => tool.name));
const input = createInterface({input: process.stdin, terminal: false});
let queue = Promise.resolve(), used = false, closing = false, idleTimer, activeCalls = 0;
const textOf = result => result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
const result = value => ({content: [{type: 'text', text: JSON.stringify(value)}]});
const emit = (id, value, error = false) => {
  if (process.stdout.destroyed) return;
  process.stdout.write(JSON.stringify({jsonrpc: '2.0', id, [error ? 'error' : 'result']: value}) + '\n');
};
const enqueue = action => {
  const next = queue.then(action);
  queue = next.catch(() => {});
  return next;
};
async function cleanup(reason) {
  clearTimeout(idleTimer);
  if (!used) { taskTitle = null; return result({closed: 0, remaining: 0, reason}); }
  // Without automatic auth the user may have selected an existing personal tab.
  if (!automatic) return result({closed: 0, preserved: true, reason: 'manual connection'});
  const listed = await backend.call('browser_tabs', {action: 'list'});
  if (listed.isError) return listed;
  // The upstream extension exposes only this client's controlled tabs, not the
  // browser-wide tab list. Close in descending order so indices cannot shift.
  const indices = [...new Set([...textOf(listed).matchAll(/^- (\d+):/gm)].map(match => Number(match[1])))].sort((a, b) => b - a);
  let closed = 0, last = listed;
  for (const index of indices) {
    last = await backend.call('browser_tabs', {action: 'close', index});
    if (last.isError) return last;
    closed++;
  }
  if (indices.length && !textOf(last).includes('No open tabs.')) {
    return {isError: true, content: [{type: 'text', text: 'Tab cleanup could not verify an empty session.'}]};
  }
  used = false;
  const task = taskTitle; taskTitle = null;
  return result({closed, remaining: 0, task, reason});
}
function armIdleCleanup() {
  clearTimeout(idleTimer);
  if (!used || closing) return;
  idleTimer = setTimeout(() => enqueue(() => cleanup('idle')).catch(() => {}), idleMs);
}
async function dispatch(message) {
  const {id, method, params = {}} = message;
  if (id === undefined || closing) return;
  if (method === 'initialize') {
    emit(id, {protocolVersion: '2025-06-18', capabilities: {tools: {}},
      serverInfo: {name: 'Codex Chrome', version: '1.2.0'},
      instructions: 'Call browser_start_task with a short task name before browser work. Work in your own temporary tabs. Always call browser_finish before reporting the browser task complete. This removes the task group and closes session tabs; do not reuse personal tabs in this temporary session.'});
  } else if (method === 'ping') emit(id, {});
  else if (method === 'tools/list') emit(id, {tools: [...backend.tools, startTool, finishTool]});
  else if (method === 'tools/call') {
    clearTimeout(idleTimer);
    activeCalls++;
    try { await enqueue(async () => {
      if (params.name === 'browser_start_task') { emit(id, await startTask(params.arguments)); return; }
      if (params.name === 'browser_finish' || params.name === 'browser_close') { emit(id, await cleanup('task finished')); return; }
      if (!names.has(params.name)) throw new Error('Tool not enabled');
      if (!taskTitle && params.name.startsWith('browser_')) throw new Error('Call browser_start_task with the current task name first');
      if (params.name.startsWith('browser_')) used = true;
      const response = await backend.call(params.name, params.arguments ?? {});
      if (!response.isError && textOf(response).includes('No open tabs.')) { used = false; taskTitle = null; }
      emit(id, response);
    }); } finally { activeCalls--; if (!activeCalls) armIdleCleanup(); }
  } else emit(id, {code: -32601, message: 'Method not found'}, true);
}
input.on('line', line => {
  let message;
  try { message = JSON.parse(line); }
  catch { emit(null, {code: -32700, message: 'Invalid JSON'}, true); return; }
  dispatch(message).catch(error => emit(message.id, {code: -32603, message: error.message}, true));
});
async function shutdown() {
  if (closing) return;
  closing = true; clearTimeout(idleTimer);
  let timeout;
  await Promise.race([
    enqueue(() => cleanup('client disconnected')),
    new Promise(resolve => { timeout = setTimeout(resolve, 10000); })
  ]).catch(() => {});
  clearTimeout(timeout);
  await backend.close();
  process.exit(0);
}
input.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdout.on('error', shutdown);
