import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptanceFixture,c} from './acceptance-http-fixture.ts';
import {createProposalAcceptanceWriteHandler} from '@accountability/knowledge-verification/proposal-acceptance-write-http';
import {createProposalAcceptanceReadHandler} from '@accountability/knowledge-verification/proposal-acceptance-http';
import {CurrentProposalAcceptanceReader} from '@accountability/knowledge-verification/proposal-acceptance-reader';
import {AcceptanceWriteClient} from '../src/acceptance-write-client.ts';
const origin='https://private.invalid';
async function setup(t:test.TestContext){
 const f=await acceptanceFixture(t),cfg={...f.fixed,origin},provider={authenticate:async()=>({actorId:c.actor.id,requestId:'browser',csrfToken:'s'.repeat(32)})};
 const write=createProposalAcceptanceWriteHandler(f.writer,f.membership,provider,cfg,()=>c.now);
 const read=createProposalAcceptanceReadHandler(new CurrentProposalAcceptanceReader(f.facade,f.review),f.membership,provider,cfg,()=>c.now);
 let lose=false;const bodies:string[]=[];
 const client=new AcceptanceWriteClient(origin,c,c.purpose,c.actor.id,async(url,init)=>{
  const isWrite=String(url).includes('acceptance-write');if(isWrite&&init?.method==='POST')bodies.push(init.body as string);
  const result=await(isWrite?write:read)(new Request(String(url),init));
  if(isWrite&&init?.method==='POST'&&result.status===200&&lose){lose=false;await result.body?.cancel();throw Error('lost actual HTTP ACK');}return result;
 });return{...f,client,bodies,setLose:()=>{lose=true;}};
}
test('actual handler acceptance ACK can be read explicitly through current source/use reader',async t=>{
 const f=await setup(t),ack=await f.client.accept('accept',f.bundle,f.input),frame=await f.client.readAcceptance(ack.acceptance);
 assert.equal(frame.claim.ref.id,'accepted');assert.equal(frame.citation.links[0]!.relation,'quotes');assert.equal(frame.record.excerpt.quote,'Neutral');f.client.dispose();
});
test('lost actual acceptance ACK replays original body once; withdrawal denies recovery without rebasing or duplicate effect',async t=>{
 const f=await setup(t);f.setLose();await assert.rejects(f.client.accept('accept',f.bundle,f.input));assert.equal((await f.repo.load(c)).revision,2);
 await f.permissions.withdraw(c,'consent','text-consent',1,'withdraw');await assert.rejects(f.client.retryPending());assert(f.client.pending);
 assert.equal(f.bodies.length,2);assert.equal(f.bodies[0],f.bodies[1]);assert.equal((await f.repo.load(c)).revision,2);f.client.dispose();
});
