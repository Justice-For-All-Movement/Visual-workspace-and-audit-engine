import test from 'node:test';import assert from 'node:assert/strict';import {JSDOM} from 'jsdom';
import {verificationFixture,c} from './verification-http-fixture.ts';
import {scoped} from '@accountability/evidence-sql/database';import type {EvidenceState} from '@accountability/evidence';
import {IdentityClaimDossierReader} from '@accountability/knowledge-verification/dossier-identity';
import {CurrentClaimDossierReader} from '@accountability/knowledge-verification/dossier-source';
import {createDossierReadHandler} from '@accountability/knowledge-verification/dossier-http';
import {DossierReadClient} from '../src/dossier-client.ts';import {mountDossierRead} from '../src/dossier-controls.ts';
async function setup(t:test.TestContext){
 const f=await verificationFixture(t),stored=await scoped(f.evidence,c,tx=>tx.get<{domain:EvidenceState}>('evidence.aggregate','project'));
 const original=await f.repo.loadEvidenceLinks(c),prior=original.state.records[0]!;
 const ack=await f.repo.recordEvidenceLinks(c,1,stored!.value.domain,{claim:prior.claim,expectedRevision:1,links:[]},'remove-current');
 const selected={claim:prior.claim,links:ack.record},origin='https://private.invalid';
 const reader=new CurrentClaimDossierReader(new IdentityClaimDossierReader(f.repo,f.membership,f.fixed),f.service,f.credential,f.makeGuard());
 const handler=createDossierReadHandler(reader,f.membership,{authenticate:async()=>({actorId:c.actor.id,requestId:'dossier-ui',csrfToken:'s'.repeat(32)})},{...f.fixed,origin},()=>c.now);
 const requests:Request[]=[];
 const transport=(async(url,init)=>{const r=new Request(String(url),init);if(r.method==='POST'){r.headers.set('origin',origin);r.headers.set('sec-fetch-site','same-origin');}requests.push(r);return handler(r);})as typeof fetch;
 const client=new DossierReadClient(origin,f.fixed,c.purpose,transport,10000,c.actor.id);
 return {...f,selected,origin,client,requests};
}
test('actual fourDB protected handler/client/control shows retained historical source and clears after current Consent withdrawal',async t=>{
 const f=await setup(t),dom=new JSDOM('<main></main>',{url:f.origin}),root=dom.window.document.querySelector('main')!;
 const control=mountDossierRead(root,f.client,f.selected);assert.equal(f.requests.length,0);const button=root.querySelector('button')!;button.click();
 for(let i=0;i<300&&!root.querySelector('table');i++)await new Promise(r=>setTimeout(r,5));
 assert(root.querySelector('table'));assert(root.textContent?.includes('Current citations: 0; retained historical challenges: 1.'));assert.equal(f.requests.length,2);
 await f.permissions.withdraw(c,'consent','consent',1,'withdraw-current-use');button.click();assert.equal(root.querySelector('table'),null);
 for(let i=0;i<300&&f.client.busy;i++)await new Promise(r=>setTimeout(r,5));assert.equal(root.querySelector('table'),null);assert.equal(f.requests.length,4);
 control.dispose();assert(f.client.closed);
});
test('actual lost owning read COMMIT stays unavailable; explicit fresh client read returns unchanged containing editions and retained history',async t=>{
 const f=await setup(t),transaction=f.knowledge.transaction.bind(f.knowledge);let lose=true;
 f.knowledge.transaction=fn=>transaction(fn).then(value=>{if(lose){lose=false;throw Error('private actual lost read COMMIT');}return value;});
 await assert.rejects(f.client.read(f.selected));assert.equal(f.requests.length,2);
 const frame=await f.client.read(f.selected);assert.equal(f.requests.length,4);assert.equal(frame.knowledgeStorage.revision,1);assert.equal(frame.linksStorage.revision,2);assert.equal(frame.dossier.historicalChallenges.length,1);f.client.dispose();
});
