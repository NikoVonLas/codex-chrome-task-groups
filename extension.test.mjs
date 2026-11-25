import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const source=(await readFile(new URL('./extension/lib/background.mjs',import.meta.url),'utf8')).split('//#region src/background.ts')[0];
function setup({delayGroup,failUngroup=false}={}) {
  const tabs=new Map(), groups=new Map(), saved=new Set(), log=[];
  let nextGroup=1;
  const event=()=>({set:new Set(),addListener(f){this.set.add(f)},removeListener(f){this.set.delete(f)},emit(...args){for(const f of this.set)f(...args)}});
  const chrome={tabs:{onUpdated:event(),onRemoved:event()},tabGroups:{},action:{}};
  Object.assign(chrome.tabs,{
    async get(id){if(!tabs.has(id))throw Error('No such tab'); return {...tabs.get(id)}},
    async group({groupId,tabIds}){
      if(delayGroup)await delayGroup;
      const id=groupId??nextGroup++; if(!groups.has(id))groups.set(id,new Set()); saved.add(id);
      for(const tabId of tabIds){tabs.get(tabId).groupId=id; groups.get(id).add(tabId); chrome.tabs.onUpdated.emit(tabId,{groupId:id},{...tabs.get(tabId)});}
      log.push(['group',id]);return id;
    },
    async ungroup(ids){
      log.push(['ungroup',[...ids]]); if(failUngroup)throw Error('ungroup denied');
      for(const id of ids){const tab=tabs.get(id);const gid=tab.groupId;const g=groups.get(gid);g?.delete(id);if(g&&!g.size){groups.delete(gid);saved.delete(gid)}tab.groupId=-1;chrome.tabs.onUpdated.emit(id,{groupId:-1},{...tab});}
    },
    async remove(ids){for(const id of Array.isArray(ids)?ids:[ids]){log.push(['remove',id]);const tab=tabs.get(id);const g=groups.get(tab.groupId);g?.delete(id);if(g&&!g.size)groups.delete(tab.groupId);tabs.delete(id);chrome.tabs.onRemoved.emit(id);}}
  });
  chrome.tabGroups.update=async(id,style)=>{log.push(['title',id,style.title])};
  for(const name of ['setBadgeText','setTitle','setBadgeBackgroundColor'])chrome.action[name]=async()=>{};
  const ctx=vm.createContext({chrome,console,setTimeout,clearTimeout});
  vm.runInContext(source+'\nglobalThis.api={Group:ConnectedTabGroup,style:uniqueGroupStyle,Relay:RelayConnection};',ctx);
  function session(id,title='Task',taken=[]) {
    tabs.set(id,{id,groupId:-1});
    const c={attachedTabs:new Set(),attachTab(tab){this.attachedTabs.add(tab.id);this.ontabattached(tab.id)},detachTab(id){log.push(['detach',id]);this.attachedTabs.delete(id);this.ontabdetached(id)},didInitialize(){}};
    const style=ctx.api.style(title,taken);
    const g=new ctx.api.Group(c,tabs.get(id),title,style,()=>false);
    return {c,g,style,async add(id){tabs.set(id,{id,groupId:-1});c.attachTab(tabs.get(id));await g._groupOperations}};
  }
  return {tabs,groups,saved,log,session,chrome,api:ctx.api};
}

test('removes group before last tab; another task survives, including an identical task name',async()=>{
  const f=setup(),a=f.session(1,'Сборка оси');await a.g._groupOperations;await a.add(2);
  const b=f.session(3,'Сборка оси',[a.style]);await b.g._groupOperations;
  assert.notEqual(a.style.title,b.style.title);assert.match(a.style.title,/Сборка оси/);
  const aid=f.tabs.get(1).groupId,bid=f.tabs.get(3).groupId;
  await a.c.removeOwnedTabs(2);await a.c.removeOwnedTabs(1);
  assert(!f.saved.has(aid));assert(f.saved.has(bid));assert(f.tabs.has(3));
  assert(!f.log.some(x=>x[0]==='detach'),'Ungrouping must not detach the relay before close');
  assert.deepEqual(f.log.filter(x=>['ungroup','remove'].includes(x[0])),[['ungroup',[2]],['remove',2],['ungroup',[1]],['remove',1]]);
});
test('rejects a mixed own/foreign close request before mutating either session',async()=>{
  const f=setup(),a=f.session(1),b=f.session(2);await Promise.all([a.g._groupOperations,b.g._groupOperations]);
  await assert.rejects(a.c.removeOwnedTabs([1,2]),/not controlled/);
  assert.equal(f.tabs.size,2);assert(!f.log.some(x=>x[0]==='ungroup'||x[0]==='remove'));
});
test('ungroup failure leaves the tab open and permits a later cleanup retry',async()=>{
  const f=setup({failUngroup:true}),a=f.session(1);await a.g._groupOperations;
  await assert.rejects(a.c.removeOwnedTabs(1),/ungroup denied/);
  assert(f.tabs.has(1));assert(!f.log.some(x=>x[0]==='remove'));assert.equal(a.g._closingTabs.size,0);
  f.chrome.tabs.ungroup=async(ids)=>{for(const id of ids)f.tabs.get(id).groupId=-1};
  await a.c.removeOwnedTabs(1);assert(!f.tabs.has(1));
});
test('closing waits for pending asynchronous group creation',async()=>{
  let release;const gate=new Promise(r=>release=r);const f=setup({delayGroup:gate}),a=f.session(1);
  const closing=a.c.removeOwnedTabs(1);release();await closing;
  assert.equal(f.tabs.size,0);assert.equal(f.saved.size,0);
});
test('protects a tab moved into a user group even before its change event is delivered',async()=>{
  const f=setup(),a=f.session(1);await a.g._groupOperations;f.tabs.get(1).groupId=999;
  await assert.rejects(a.c.removeOwnedTabs(1),/another group/);assert(f.tabs.has(1));
});
test('disconnect while grouping is pending cannot leave the newly created group behind',async()=>{
  let release;const gate=new Promise(r=>release=r);const f=setup({delayGroup:gate}),a=f.session(1);
  await Promise.resolve();a.c.onclose();release();await a.g._groupOperations;
  assert.equal(f.saved.size,0);assert.equal(f.tabs.size,1,'Disconnect preserves the page for existing upstream semantics');
});
test('a tab can be grouped again after this session emptied its prior group',async()=>{
  const f=setup(),a=f.session(1);await a.g._groupOperations;await a.c.removeOwnedTabs(1);await a.add(2);
  assert.notEqual(f.tabs.get(2).groupId,-1);await a.c.removeOwnedTabs(2);assert.equal(f.saved.size,0);
});
test('relay dispatch uses owned cleanup before Chrome tabs.remove',async()=>{
  const f=setup();let received;
  const result=await f.api.Relay.prototype._handleCommand.call({removeOwnedTabs:async ids=>{received=ids;return 'cleaned'}},{method:'chrome.tabs.remove',params:[[7,8]]});
  assert.deepEqual(received,[7,8]);assert.equal(result,'cleaned');
});
