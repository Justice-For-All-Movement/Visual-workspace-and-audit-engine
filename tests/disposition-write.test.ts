import test from 'node:test';
import assert from 'node:assert/strict';
import {ready,c,origin} from './disposition-http-fixture.ts';
import {IdentityQuestionDispositionRepository} from '@accountability/factual-investigation/disposition-identity';
import {createDispositionWriteHandler} from '@accountability/factual-investigation/disposition-write-http';
import {DISPOSITION_KEY} from '@accountability/factual-investigation/disposition-repository';
import {DispositionWriteClient} from '../src/disposition-write-client.ts';
async function fixture(t: test.TestContext) {
 const f=await ready(t);
 const write=createDispositionWriteHandler(new IdentityQuestionDispositionRepository(f.store,f.membership,f.fixed),f.membership,{authenticate:async()=>({actorId:c.actor.id,requestId:c.requestId,csrfToken:'fixture-csrf-token-0000000000000000000000'})},{...f.fixed,origin},()=>c.now);
 const calls: {url:string,body:string|undefined}[]=[];
 const state={lose:false,reject:false,actor:false,corrupt:false};
 const client=new DispositionWriteClient(origin,c,c.purpose,async(url,init)=>{
   calls.push({url:String(url),body:init?.body as string|undefined});
   if(state.actor && String(url).endsWith('/disposition-write/session')) return new Response(JSON.stringify({actorId:'different-human',csrfToken:'fixture-csrf-token-0000000000000000000000'}),{headers:{'content-type':'application/json','cache-control':'no-store'}});
   const response=await (String(url).includes('/disposition-write/')?write:f.handler)(new Request(String(url),init));
   if(String(url).endsWith('/disposition-write/record')) {
     if(state.lose){state.lose=false;throw Error('lost network acknowledgement');}
     if(state.reject) return new Response('{}',{status:503});
     if(state.corrupt) {const a=await response.json();a.planningStorage.revision++;return new Response(JSON.stringify(a),{headers:{'content-type':'application/json','cache-control':'no-store'}});}
   }
   return response;
 });
 t.after(()=>client.dispose());return {...f,client,calls,state};
}
const rows=[{questionId:'time',status:'unresolved' as const,reason:'Evidence remains unassessed',assigneeId:null,reviewAt:null}];
test('actual write binds all owning editions and whole unanswered review; ACK requires a fresh explicit read',async t=>{
 const f=await fixture(t);assert.equal(f.calls.length,0);
 await f.client.load(f.ack.record);
 const ack=await f.client.record('cmd2','review2',rows,['New authorized record']);
 assert.equal(ack.storage.id,DISPOSITION_KEY);assert.equal(ack.storage.revision,2);assert.equal(ack.record.revision,1);
 assert.deepEqual(ack.planningStorage,f.ack.storage);assert.equal(ack.effortStorage,null);assert.equal(f.client.viewed,null);assert.equal(f.client.pending,null);
 await assert.rejects(f.client.record('cmd3','review3',rows,['New record']));
 const later=await f.client.load(f.ack.record);assert.equal(later.table.history.length,2);assert.equal(later.table.latestReview?.questions[0]?.status,'unresolved');
 const body=JSON.parse(f.calls.find(x=>x.url.endsWith('/disposition-write/record'))!.body!);
 assert.equal(body.expectedStorageRevision,1);assert.equal(body.command.review.expectedSequence,1);assert.deepEqual(body.command.review.supersedes,f.reviewAck.record);
});
test('actual committed lost ACK preserves immutable manual replay and makes only one review',async t=>{
 const f=await fixture(t);await f.client.load(f.ack.record);f.state.lose=true;
 await assert.rejects(f.client.record('lost','review2',rows,['New record']));
 const original=f.client.pending;assert.ok(original);(original.command.review.questions[0] as any).reason='mutated copy';
 await assert.rejects(f.client.load(f.ack.record));await assert.rejects(f.client.record('other','other',rows,['New record']));
 const ack=await f.client.retryPending();assert.equal(ack.storage.revision,2);
 const posts=f.calls.filter(x=>x.url.endsWith('/disposition-write/record'));assert.equal(posts.length,2);assert.equal(posts[0]!.body,posts[1]!.body);
 const later=await f.client.load(f.ack.record);assert.equal(later.table.history.length,2);assert.equal(later.table.latestReview!.questions[0]!.reason,rows[0]!.reason);
});
test('actual current resource withdrawal denies cached replay and retains pending',async t=>{
 const f=await fixture(t);await f.client.load(f.ack.record);f.state.lose=true;await assert.rejects(f.client.record('lost','review2',rows,['New record']));
 await f.membership.setResourcePolicy(c,1,{...f.policy,memberIds:[]},'withdraw');
 await assert.rejects(f.client.retryPending());assert.ok(f.client.pending);assert.equal(f.client.viewed,null);
});
test('actor change closes before POST; record author metadata never substitutes for current viewer',async t=>{
 const f=await fixture(t);await f.client.load(f.ack.record);f.state.actor=true;
 await assert.rejects(f.client.record('cmd','r2',rows,['New record']));assert.equal(f.client.closed,true);assert.equal(f.calls.filter(x=>x.url.endsWith('/record')).length,0);
});
test('getter and incomplete question input denied before write I/O; disposal fences record',async t=>{
 const f=await fixture(t);await f.client.load(f.ack.record);const count=f.calls.length;
 const bad={...rows[0]!,get reason(): string{throw Error('must not invoke')}};
 await assert.rejects(f.client.record('cmd','r2',[bad],['New record']));await assert.rejects(f.client.record('cmd','r2',[],['New record']));assert.equal(f.calls.length,count);assert.equal(f.client.pending,null);
 f.client.dispose();await assert.rejects(f.client.record('cmd','r2',rows,['New record']));assert.equal(f.calls.length,count);
});
test('malformed ACK with changed actual planning edition locks exact pending without invented new view',async t=>{
 const f=await fixture(t);await f.client.load(f.ack.record);f.state.corrupt=true;
 await assert.rejects(f.client.record('cmd','r2',rows,['New record']));assert.ok(f.client.pending);assert.equal(f.client.viewed,null);
 f.state.corrupt=false;assert.equal((await f.client.retryPending()).storage.revision,2);
});
function json(value:unknown) {return new Response(JSON.stringify(value),{headers:{'content-type':'application/json','cache-control':'no-store'}});}
test('blocked late write session cannot POST; signals close and timeout includes synchronous transport',async t=>{
 const f=await fixture(t);const frame=await f.client.load(f.ack.record);const signals:AbortSignal[]=[];let posts=0;
 const client=new DispositionWriteClient(origin,c,c.purpose,async(url,init)=>{
  signals.push(init!.signal! as AbortSignal);
  if(String(url).endsWith('/read')) return json(frame);
  if(String(url).endsWith('/disposition-write/session')) {const end=performance.now()+40;while(performance.now()<end){};}
  if(String(url).endsWith('/record'))posts++;
  return json({actorId:c.actor.id,csrfToken:'fixture-csrf-token-0000000000000000000000'});
 },20);t.after(()=>client.dispose());
 await client.load(f.ack.record);await assert.rejects(client.record('late','r2',rows,['New record']));assert.equal(posts,0);assert.equal(client.pending,null);assert.ok(signals.every(s=>s.aborted));
});
test('noncooperative late POST after cancellation retains pending and cancels response body',async t=>{
 const f=await fixture(t);const frame=await f.client.load(f.ack.record);let release!:(v:Response)=>void;let began!:()=>void;const started=new Promise<void>(r=>began=r);let cancelled=false;
 const client=new DispositionWriteClient(origin,c,c.purpose,async(url)=>{
  if(String(url).endsWith('/read'))return json(frame);
  if(String(url).endsWith('/record')){began();return new Promise<Response>(r=>release=r);}
  return json({actorId:c.actor.id,csrfToken:'fixture-csrf-token-0000000000000000000000'});
 });t.after(()=>client.dispose());await client.load(f.ack.record);
 const ac=new AbortController();const sending=client.record('cancel','r2',rows,['New record'],ac.signal);await started;ac.abort();await assert.rejects(sending);assert.ok(client.pending);assert.equal(client.viewed,null);
 release(new Response(new ReadableStream({cancel(){cancelled=true;}})));await new Promise(r=>setTimeout(r,0));assert.equal(cancelled,true);assert.ok(client.pending);
});
test('preflight reentry and disposal cannot dispatch or replace pending; arrays reject accessor elements',async t=>{
 const f=await fixture(t);await f.client.load(f.ack.record);const calls=f.calls.length;let entered:Promise<unknown>|null=null;
 const proxy=new Proxy(rows[0]!,{getPrototypeOf(target){entered=f.client.record('nested','nested',rows,['New record']).catch(e=>e);return Reflect.getPrototypeOf(target);}});
 await f.client.record('outer','r2',[proxy],['New record']);assert.ok(entered);assert.ok(await entered);assert.equal(f.calls.filter(x=>x.url.endsWith('/record')).length,1);
 await f.client.load(f.ack.record);const array=[rows[0]!];Object.defineProperty(array,'0',{get(){throw Error('getter must not run');}});
 await assert.rejects(f.client.record('getter','r3',array,['New record']));
 const poison=new Proxy(rows[0]!,{getPrototypeOf(target){f.client.dispose();return Reflect.getPrototypeOf(target);}});const before=f.calls.length;
 await assert.rejects(f.client.record('dispose','r3',[poison],['New record']));assert.equal(f.calls.length,before);assert.ok(calls>0);
});
