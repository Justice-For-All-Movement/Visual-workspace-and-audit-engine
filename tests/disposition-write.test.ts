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
