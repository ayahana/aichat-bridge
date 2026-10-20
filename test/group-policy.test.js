import test from 'node:test';
import assert from 'node:assert/strict';
import { groupPolicy, triggerFor, boundedContext } from '../extension/group-policy.js';
import { BridgeStore } from '../extension/qq-store.js';
import { StorageConflictError } from '../extension/storage.js';
class Storage {
 state = null;
 async readState() { return structuredClone(this.state); }
 async listImageKeys() { return []; }
 async commit({expectedRevision,state}) { if ((this.state?.revision ?? 0) !== expectedRevision) throw new StorageConflictError(); this.state = structuredClone({...state,revision:expectedRevision+1}); return this.state.revision; }
}
const caller = {chatId:'group_a',browserId:'browser',tabId:1,conversationUrl:'https://chatgpt.com/c/group-only'};
async function fixture() {
 const storage = new Storage(), clock = {now:1800000000000};
 const store = await BridgeStore.open({storage,now:()=>clock.now,moderate:()=>({blocked:false})});
 await store.bind(caller);
 let n = 0;
 const send = (extra={}) => store.ingest({messageId:`msg${++n}`,chatId:'group_a',senderId:'member_a',eventType:'GROUP_MESSAGE_CREATE',text:'小助手，你好',createdAt:clock.now,...extra});
 const policy = p => store.setGroupPolicy({chatId:'group_a',policy:p});
 return {store,storage,clock,send,policy};
}
test('migration defaults, strict bounded policy and prefix boundaries',()=>{
 assert.equal(groupPolicy().enabled,false); assert.equal(groupPolicy().contextEnabled,false);
 for (const bad of [{enabled:1},{continuationSeconds:121},{maxPending:0},{nicknames:['']},{cooldownSeconds:-1}]) assert.throws(()=>groupPolicy(bad));
 const group = {binding:{},policy:{enabled:true,nicknames:['Bot']}};
 for (const text of ['Botany','some Bot','引用 Bot']) assert.equal(triggerFor({eventType:'GROUP_MESSAGE_CREATE',text},group,1),null);
 assert.equal(triggerFor({eventType:'GROUP_MESSAGE_CREATE',text:'Bot: help'},group,1),'nickname');
 assert.equal(triggerFor({eventType:'GROUP_MESSAGE_CREATE',text:'Bot: quoted',currentText:'hello'},group,1),null);
});
test('ordinary defaults, unknown groups and paused groups are silent; @ still works',async()=>{
 const f=await fixture(); assert.equal((await f.send()).ignored,true);
 assert.equal((await f.send({chatId:'unknown',unsupportedAttachments:true})).ignored,true);
 assert.equal((await f.store.status()).groups.length,1); assert.equal(await f.store.nextReply(),null);
 assert.equal((await f.send({eventType:'GROUP_AT_MESSAGE_CREATE'})).accepted,true);
 await f.policy({enabled:true,paused:true,nicknames:['小助手']});
 assert.equal((await f.send({eventType:'GROUP_AT_MESSAGE_CREATE'})).ignored,true);
 assert.equal((await f.store.status()).jobs.length,1);
});
test('nickname triggers carry identity, deduplicate and apply cooldown atomically',async()=>{
 const f=await fixture();await f.policy({enabled:true,nicknames:['小助手']});
 const results=await Promise.all([f.send({messageId:'same'}),f.send({messageId:'same'}),f.send()]);
 assert.equal(results.filter(x=>x.accepted).length,1);assert.equal(results[1].duplicate,true);assert.equal(results[2].limited,true);
 const {job}=await f.store.poll(caller);assert.match(job.prompt,/member_a/);assert.match(job.prompt,/本次问题/);
});
test('continuation is same sender and fixed expiry, ignored or continued events do not extend it',async()=>{
 const f=await fixture();await f.policy({enabled:true,nicknames:['小助手'],continuationSeconds:30,cooldownSeconds:0,maxPending:10});
 assert.equal((await f.send()).accepted,true);
 assert.equal((await f.send({text:'before delivery'})).ignored,true);
 const {job}=await f.store.poll(caller),auth={...caller,leaseToken:job.leaseToken};
 await f.store.started(job.id,auth);await f.store.result(job.id,{...auth,text:'reply'});await f.store.replySent((await f.store.nextReply()).id,{messageId:'bot'});
 f.clock.now+=10000;
 assert.equal((await f.send({text:'delayed previous message',createdAt:f.clock.now-11000})).ignored,true);
 assert.equal((await f.send({text:'继续',senderId:'member_b'})).ignored,true);
 assert.equal((await f.send({text:'继续'})).accepted,true);
 f.clock.now+=21000;assert.equal((await f.send({text:'继续'})).ignored,true);
 assert.equal((await f.send({createdAt:f.clock.now+6000})).stale,true);
});
test('context opt-in is bounded, moderated before use, isolated and cleared on disable/rebind',async()=>{
 const f=await fixture();await f.policy({enabled:true,nicknames:['小助手'],contextEnabled:true,cooldownSeconds:0});
 for(let i=0;i<20;i++) await f.send({text:'上下文'+i+'x'.repeat(600)});
 assert.equal(f.storage.state.groups.group_a.context.length,8);
 assert.ok(f.storage.state.groups.group_a.context.every(x=>x.text.length<=500));
 await f.send();const {job}=await f.store.poll(caller);assert.match(job.prompt,/近期群聊资料/);assert.ok(job.prompt.length<12000);
 await f.policy({enabled:true});assert.equal(f.storage.state.groups.group_a.context,undefined);
});
test('context TTL prunes during sweep and ordinary flood metadata has global cap',async()=>{
 const f=await fixture();await f.policy({enabled:true,contextEnabled:true});
 await f.send({text:'stale context',createdAt:f.clock.now-121000});assert.equal(f.storage.state.groups.group_a.context.length,0);
 await f.send({text:'context'});f.clock.now+=121000;await f.store.sweep();assert.equal(f.storage.state.groups.group_a.context.length,0);
 assert.equal(boundedContext(Array.from({length:20},()=>({at:f.clock.now})),f.clock.now).length,8);
});
test('reference trigger only matches successful QQ receipt IDs, never current user or unknown IDs',async()=>{
 const f=await fixture();await f.policy({enabled:true,replyToBot:true,cooldownSeconds:0});
 assert.equal((await f.send({replyToMessageId:'not-confirmed'})).ignored,true);
 await f.send({eventType:'GROUP_AT_MESSAGE_CREATE'});const {job}=await f.store.poll(caller),auth={...caller,leaseToken:job.leaseToken};
 await f.store.started(job.id,auth);await f.store.result(job.id,{...auth,text:'reply'});
 const item=await f.store.nextReply();await f.store.replySent(item.id,{messageId:'bot_reply_1'});
 assert.equal((await f.send({text:'follow',replyToMessageId:'bot_reply_1'})).accepted,true);
 assert.equal((await f.send({messageId:'bot_reply_1'})).ignored,true);
});
test('queue limits do not renew session and stage diagnostics cannot extend deadlines',async()=>{
 const f=await fixture();await f.policy({enabled:true,nicknames:['小助手'],cooldownSeconds:0,maxPending:1,continuationSeconds:30});
 await f.send();const expires=f.storage.state.groups.group_a.session;f.clock.now+=1000;
 assert.equal((await f.send()).accepted,false);assert.equal(f.storage.state.groups.group_a.session,expires);
 const {job}=await f.store.poll(caller),auth={...caller,leaseToken:job.leaseToken};await f.store.started(job.id,auth);
 const deadline=f.storage.state.jobs[0].deadline;
 await f.store.stage(job.id,{...auth,stage:'submitted'});const first=f.storage.state.jobs[0].stages.submitted;
 f.clock.now++;await f.store.stage(job.id,{...auth,stage:'submitted'});
 assert.equal(f.storage.state.jobs[0].stages.submitted,first);assert.equal(f.storage.state.jobs[0].deadline,deadline);
 await assert.rejects(f.store.stage(job.id,{...auth,leaseToken:'bad',stage:'submitted'}));
 await assert.rejects(f.store.stage(job.id,{...auth,stage:'arbitrary secret'}));
});
test('context revocation cancels queued snapshots but leaves ordinary queued requests intact',async()=>{
 const f=await fixture();await f.policy({enabled:true,contextEnabled:true,nicknames:['小助手'],cooldownSeconds:0});
 await f.send({text:'private context'});await f.send();
 assert.equal(f.storage.state.jobs[0].contextUsed,true);
 await f.policy({enabled:true,nicknames:['小助手']});
 assert.equal(f.storage.state.jobs[0].state,'cancelled');assert.equal(f.storage.state.jobs[0].prompt,undefined);
 assert.equal((await f.store.poll(caller)).job,null);
});
test('global context cache retains at most 32 groups and rebind clears retained metadata',async()=>{
 const f=await fixture();
 for(let i=0;i<33;i++) {
  const chatId=`group_${i}`;await f.store.bind({...caller,chatId,tabId:i+2,conversationUrl:`https://chatgpt.com/c/group-chat-${i}`});
  await f.store.setGroupPolicy({chatId,policy:{enabled:true,contextEnabled:true}});
  await f.send({chatId,text:'context'});f.clock.now++;
 }
 assert.equal(Object.values(f.storage.state.groups).filter(x=>x.context?.length).length,32);
 await f.store.bind({...caller,chatId:'group_32',tabId:34,conversationUrl:'https://chatgpt.com/c/new-chat'});
 assert.equal(f.storage.state.groups.group_32.context,undefined);
});
test('bot identity and reference normalization retain no authorization tokens',async()=>{
 const {normalizeMessage}=await import('../extension/qq-message.js');
 const event={t:'GROUP_MESSAGE_CREATE',d:{id:'m',group_openid:'g',timestamp:'2026-10-20T01:00:00Z',author:{id:'bot'},content:'hi',message_reference:{message_id:'reply',auth_token:'secret'}}};
 assert.equal(normalizeMessage(event,{botId:'bot'}),null);
 const result=normalizeMessage({...event,d:{...event.d,author:{id:'human'}}});
 assert.equal(result.replyToMessageId,'reply');assert.ok(!JSON.stringify(result).includes('secret'));
});
test('late delivery after rebinding never seeds a new conversation session or reply IDs',async()=>{
 const f=await fixture();await f.policy({enabled:true,replyToBot:true,continuationSeconds:30,cooldownSeconds:0});
 await f.send({eventType:'GROUP_AT_MESSAGE_CREATE'});const {job}=await f.store.poll(caller),auth={...caller,leaseToken:job.leaseToken};
 await f.store.started(job.id,auth);await f.store.result(job.id,{...auth,text:'answer'});const item=await f.store.nextReply();
 await f.store.bind({...caller,conversationUrl:'https://chatgpt.com/c/new-conversation'});
 await f.store.replySent(item.id,{messageId:'old-reply'});
 assert.equal(f.storage.state.groups.group_a.session,undefined);assert.equal(f.storage.state.groups.group_a.sentMessageIds,undefined);
 assert.equal((await f.send({text:'follow',replyToMessageId:'old-reply'})).ignored,true);
});
