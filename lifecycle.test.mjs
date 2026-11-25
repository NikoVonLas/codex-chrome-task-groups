import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connectChrome} from './client.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
const text=r=>r.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')??'';
const fake=`import {appendFile} from 'node:fs/promises';
const log=x=>appendFile(process.env.TEST_LOG,JSON.stringify(x)+'\\n');
const result=t=>({content:[{type:'text',text:t}]});
export async function connectChrome({clientName='bootstrap'}) {
  await log({op:'connect',name:clientName});let tabs=[];
  return {tools:[{name:'browser_tabs',inputSchema:{type:'object'}},{name:'browser_close',inputSchema:{type:'object'}}],
    async call(name,args){
      await log({op:'call',name:clientName,tool:name,args});
      if(args.action==='new')tabs.push(args.url??'test');
      if(args.action==='close') {
        if(process.env.TEST_FAIL_CLOSE==='1')return {isError:true,content:[{type:'text',text:'close failed'}]};
        tabs.splice(args.index,1);
      }
      return result(tabs.length?tabs.map((t,i)=>'- '+i+': ['+t+'](about:blank)').join('\\n'):'No open tabs.');
    },async close(){await log({op:'disconnect',name:clientName})}
  }
}`;
async function fixture({idle=60000,failClose=false}={}) {
  const dir=await mkdtemp(join(tmpdir(),'task-groups-'));
  await writeFile(join(dir,'client.mjs'),fake);
  await writeFile(join(dir,'lifecycle-server.mjs'),await readFile(new URL('./lifecycle-server.mjs',import.meta.url)));
  const logfile=join(dir,'events.jsonl');await writeFile(logfile,'');
  const client=await connectChrome({workspace:dir,launcher:process.execPath,launcherArgs:[join(dir,'lifecycle-server.mjs')],env:{PLAYWRIGHT_MCP_EXTENSION_TOKEN:'test-only-placeholder',CODEX_CHROME_IDLE_MS:String(idle),TEST_LOG:logfile,TEST_FAIL_CLOSE:failClose?'1':'0'}});
  return {client,events:async()=>(await readFile(logfile,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse),async dispose(){await client.close();await rm(dir,{recursive:true,force:true})}};
}
test('task name reaches the MCP client handshake; switching tasks closes only the previous task',async()=>{
  const f=await fixture();try{
    assert(f.client.tools.some(x=>x.name==='browser_start_task'));
    await assert.rejects(f.client.call('browser_tabs',{action:'new'}),/browser_start_task/);
    await f.client.call('browser_start_task',{task:'  Сборка рамы  '});
    await f.client.call('browser_tabs',{action:'new',url:'A'});
    await f.client.call('browser_tabs',{action:'new',url:'A2'});
    await f.client.call('browser_start_task',{task:'Проверка оси'});
    await f.client.call('browser_tabs',{action:'new',url:'B'});
    const end=JSON.parse(text(await f.client.call('browser_finish')));assert.equal(end.closed,1);assert.equal(end.remaining,0);assert.equal(end.task,'Проверка оси');
    const events=await f.events();assert.deepEqual(events.filter(e=>e.op==='connect').map(e=>e.name),['bootstrap','Сборка рамы','Проверка оси']);
    assert.deepEqual(events.filter(e=>e.op==='call'&&e.args.action==='close').map(e=>[e.name,e.args.index]),[['Сборка рамы',1],['Сборка рамы',0],['Проверка оси',0]]);
  }finally{await f.dispose()}
});
test('invalid titles cannot close the running task',async()=>{
  const f=await fixture();try{
    await f.client.call('browser_start_task',{task:'Keep'});await f.client.call('browser_tabs',{action:'new'});
    for(const task of ['', 'x'.repeat(81),'A\nB'])await assert.rejects(f.client.call('browser_start_task',{task}),/Task name/);
    assert(!(await f.events()).some(e=>e.args?.action==='close'));
  }finally{await f.dispose()}
});
test('browser_close follows the same cleanup path as browser_finish',async()=>{
  const f=await fixture();try{
    await f.client.call('browser_start_task',{task:'Close'});await f.client.call('browser_tabs',{action:'new'});
    assert.equal(JSON.parse(text(await f.client.call('browser_close'))).remaining,0);
    assert(!(await f.events()).some(e=>e.tool==='browser_close'));
  }finally{await f.dispose()}
});
test('a cleanup error prevents task switch and never reports success',async()=>{
  const f=await fixture({failClose:true});try{
    await f.client.call('browser_start_task',{task:'Keep'});await f.client.call('browser_tabs',{action:'new'});
    assert.equal((await f.client.call('browser_start_task',{task:'New'})).isError,true);
    assert.equal((await f.client.call('browser_finish')).isError,true);
    assert(!(await f.events()).some(e=>e.op==='connect'&&e.name==='New'));
  }finally{await f.dispose()}
});
test('idle and disconnect both close owned tabs',async()=>{
  for(const mode of ['idle','disconnect']){
    const f=await fixture({idle:mode==='idle'?100:60000});try{
      await f.client.call('browser_start_task',{task:mode});await f.client.call('browser_tabs',{action:'new'});
      if(mode==='disconnect')await f.client.disconnect();
      else{for(let i=0;i<20;i++){if((await f.events()).some(e=>e.args?.action==='close'))break;await new Promise(r=>setTimeout(r,25))}}
      assert((await f.events()).some(e=>e.name===mode&&e.args?.action==='close'));
    }finally{await f.dispose()}
  }
});
