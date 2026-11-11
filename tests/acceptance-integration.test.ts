import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {acceptanceFixture,c} from './acceptance-http-fixture.ts';
import {CurrentProposalAcceptanceReader} from '@accountability/knowledge-verification/proposal-acceptance-reader';
import {createProposalAcceptanceReadHandler} from '@accountability/knowledge-verification/proposal-acceptance-http';
import {AcceptanceReadClient} from '../src/acceptance-client.ts';
import {mountAcceptanceRead} from '../src/acceptance-controls.ts';
const origin='https://private.invalid';
async function setup(t:test.TestContext){
 const f=await acceptanceFixture(t),ack=await f.writer.accept(c,f.bundle,f.input,'accept');
 const handler=createProposalAcceptanceReadHandler(new CurrentProposalAcceptanceReader(f.facade,f.review),f.membership,
 {authenticate:async()=>({actorId:c.actor.id,requestId:'browser',csrfToken:'s'.repeat(32)})},{...f.fixed,origin},()=>c.now);
 const client=new AcceptanceReadClient(origin,c,c.purpose,async(url,init)=>handler(new Request(String(url),init)));
 return {...f,ack,handler,client};
}
test('client parses actual accepted handler over four restricted migrated databases and encrypted Evidence',async t=>{
 const f=await setup(t),frame=await f.client.read(f.ack.acceptance);
 assert.deepEqual(frame.record.claim,f.ack.claim);assert.equal(frame.citation.links[0]!.relation,'quotes');
 assert.equal(frame.record.excerpt.quote,'Neutral');assert.equal(frame.knowledgeStorage.revision,2);
 assert.equal(frame.linksStorage.revision,3);assert(f.signal()?.aborted);f.client.dispose();
});
test('mounted real acceptance read clears prior observation after current Consent withdrawal',async t=>{
 const f=await setup(t),dom=new JSDOM('<main></main>',{url:origin}),root=dom.window.document.querySelector('main')!;
 const controls=mountAcceptanceRead(root,f.client,f.ack.acceptance),button=root.querySelector('button')!;
 button.click();for(let n=0;n<400&&!root.querySelector('blockquote');n++)await new Promise(r=>setTimeout(r,5));
 assert(root.querySelector('blockquote'));await f.permissions.withdraw(c,'consent','text-consent',1,'withdraw');
 button.click();assert.equal(root.querySelector('blockquote'),null);
 for(let n=0;n<400&&button.disabled;n++)await new Promise(r=>setTimeout(r,5));
 assert.equal(root.querySelector('blockquote'),null);assert(!button.disabled);controls.dispose();
});
test('lost actual selected-read COMMIT is withheld through HTTP/client and fresh explicit read retains one acceptance',async t=>{
 const f=await setup(t),original=f.knowledge.transaction.bind(f.knowledge);let lose=true;
 f.knowledge.transaction=fn=>{let selected=false;return original(tx=>fn({query:async<T>(sql:string,v?:unknown[])=>{const result=await tx.query<T>(sql,v);if(sql.includes('INSERT INTO public.evidence_audit')&&v?.includes('knowledge.proposal-acceptance.read_checked'))selected=true;return result;}})).then(value=>{if(selected&&lose){lose=false;throw Error('private lost read COMMIT');}return value;});};
 await assert.rejects(f.client.read(f.ack.acceptance));assert.deepEqual((await f.client.read(f.ack.acceptance)).acceptance,f.ack.acceptance);
 assert.equal((await f.repo.load(c)).revision,2);f.client.dispose();
});
