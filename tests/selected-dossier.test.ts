import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {dossierFixture} from './selected-dossier-fixture.ts';
import {parseSelectedDossierFrame,renderSelectedDossierFrame,captureDossierSelection} from '../src/selected-dossier.ts';
test('actual pure SDK dossier preserves removed historical challenges, empty current citations and observed editions',()=>{
 const {scope,selected,frame}=dossierFixture();assert.deepEqual(parseSelectedDossierFrame(scope,selected,JSON.stringify(frame)),frame);
 const parsed=parseSelectedDossierFrame(scope,selected,JSON.stringify(frame));assert.equal(parsed.dossier.citations.links.length,0);assert.equal(parsed.dossier.historicalChallenges[0]!.link.selector.kind,'text');assert.equal(parsed.sourceObligations.length,1);
 assert.equal(parsed.dossier.claim.value.type==='claim'&&parsed.dossier.claim.value.assessment,null);
});
test('whole frame rejects injected authority, missing contrary obligations, foreign refs and invented containing revisions',()=>{
 const {scope,selected,frame}=dossierFixture();
 const edits=[(f:any)=>f.permission='allowed',(f:any)=>f.sourceObligations=[],(f:any)=>f.dossier.historicalChallenges[0].link.relation='supports',
 (f:any)=>f.dossier.claim.value.assessment='verified',(f:any)=>f.knowledgeStorage.revision=7,(f:any)=>f.linksStorage.id='f'.repeat(64),
 (f:any)=>f.dossier.historicalChallenges[0].claim.projectId='elsewhere',(f:any)=>f.dossier.historicalChallenges[0].citationSet.revision=2,
 (f:any)=>f.dossier.citations.claim.revision=2,(f:any)=>f.dossier.purpose='publish',(f:any)=>f.dossier.unloaded=[],
 (f:any)=>f.dossier.historicalChallenges[0].link.selector.end=3,(f:any)=>f.dossier.historicalChallenges.push(f.dossier.historicalChallenges[0]),
 (f:any)=>{const h=structuredClone(f.dossier.historicalChallenges[0]);h.link.id='another-id';f.dossier.historicalChallenges.push(h);f.sourceObligations.push({citationSet:h.citationSet,linkId:h.link.id,selector:h.link.selector});}];
 for(const edit of edits){const f=structuredClone(frame);edit(f);assert.throws(()=>parseSelectedDossierFrame(scope,selected,JSON.stringify(f)),{code:'invalid_response'});}
});
test('selection captures exact own data refs; getters and extra fields cannot choose another dossier',()=>{
 const {scope,selected}=dossierFixture();let reads=0;const choice={...selected};Object.defineProperty(choice,'claim',{enumerable:true,get(){reads++;return selected.claim;}});
 assert.throws(()=>captureDossierSelection(scope,choice));assert.equal(reads,0);
 assert.throws(()=>captureDossierSelection(scope,{...selected,extra:true} as never));
 const captured=captureDossierSelection(scope,selected);assert.notEqual(captured,selected);assert.notEqual(captured.claim,selected.claim);
});
test('literal table and inspector keep source and malicious claim strings inert without inventing audit events',()=>{
 const {scope,selected,frame}=dossierFixture();const f=structuredClone(frame);if(f.dossier.claim.value.type==='claim')(f.dossier.claim.value as {text:string}).text='<img src=x onerror=alert(1)> private literal';
 const dom=new JSDOM('<main></main>');const view=renderSelectedDossierFrame(dom.window.document,scope,selected,JSON.stringify(f));dom.window.document.body.append(view);
 assert.equal(view.querySelectorAll('img,script,a,iframe').length,0);assert(view.textContent?.includes('<img src=x onerror=alert(1)>'));assert(view.textContent?.includes('Historical challenge'));assert(view.textContent?.includes('not creation editions'));
});
import {reviseKnowledge} from '@accountability/knowledge-verification';
import {reviseEvidenceLinks} from '@accountability/knowledge-verification/evidence-links';
import {createCapturedClaimDossier} from '@accountability/knowledge-verification/claim-dossier';
import {c} from './selected-acceptance-fixture.ts';
test('actual captured subject editions stay separate from later observed entities; partial UTC and null tracks remain literal',()=>{
 const {scope,frame,d}=dossierFixture();let knowledge=reviseKnowledge(c,d.knowledge,{id:'subject',expectedRevision:0,value:{type:'entity',label:'Earlier entity',category:'unknown',description:'Unassessed'}});
 const subject=knowledge.records.at(-1)!;
 knowledge=reviseKnowledge(c,knowledge,{id:'parent',expectedRevision:1,value:{...(d.knowledge.records[0]!.value as Extract<typeof d.knowledge.records[number]['value'],{type:'claim'}>),subjectRefs:[subject.ref],time:{earliest:null,latest:'2026-01-02T00:00:00Z'}}});
 const claim=knowledge.records.at(-1)!.ref;
 knowledge=reviseKnowledge(c,knowledge,{id:'subject',expectedRevision:1,value:{type:'entity',label:'Later entity',category:'unknown',description:'Changed assertion'}});
 const links=reviseEvidenceLinks(c,knowledge,d.source,d.links,{claim,expectedRevision:1,links:[]});const selected={claim,links:links.records.at(-1)!.ref};
 const dossier=createCapturedClaimDossier(c,JSON.stringify({knowledge,links}),selected);
 const f={...frame,knowledgeStorage:{...frame.knowledgeStorage,revision:4},dossier,sourceObligations:dossier.historicalChallenges.map(h=>({citationSet:h.citationSet,linkId:h.link.id,selector:h.link.selector}))};
 const parsed=parseSelectedDossierFrame(scope,selected,JSON.stringify(f));assert.equal(parsed.dossier.subjects[0]!.status,'changed-in-capture');assert.equal(parsed.dossier.subjects[0]!.record.ref.revision,1);assert.equal(parsed.dossier.subjects[0]!.latestObserved.revision,2);
 const bad=structuredClone(f);(bad.dossier.subjects[0] as {status:string}).status='same-edition';assert.throws(()=>parseSelectedDossierFrame(scope,selected,JSON.stringify(bad)));
});
test('whole512KiB UTF8 input boundary accepts exact limit and rejects one more byte without truncating historical rows',()=>{
 const {scope,selected,frame}=dossierFixture(),text=JSON.stringify(frame),bytes=new TextEncoder().encode(text).length;
 const exact=text+' '.repeat(524288-bytes);assert.equal(new TextEncoder().encode(exact).length,524288);assert.equal(parseSelectedDossierFrame(scope,selected,exact).dossier.historicalChallenges.length,1);assert.throws(()=>parseSelectedDossierFrame(scope,selected,exact+' '));
});
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {KnowledgeRepository} from '@accountability/knowledge-verification/repository';
import {scoped} from '@accountability/evidence-sql/database';
import type {Database} from '@accountability/evidence-sql/database';
test('actual owning restricted-migration SDK frame parses containing revisions and retains removed contrary material through read audit',async t=>{
 const {scope,d}=dossierFixture(),pg=new PGlite();t.after(()=>pg.close());
 await pg.exec(await readFile(new URL('../migrations/001_foundation.sql',import.meta.resolve('@accountability/evidence-sql/database')),'utf8'));
 await pg.exec('CREATE ROLE dossier_login LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; GRANT evidence_runtime TO dossier_login; SET SESSION AUTHORIZATION dossier_login');
 const db:Database={transaction:fn=>pg.transaction(q=>fn({query:async<T>(sql:string,args?:unknown[])=>({rows:(await q.query(sql,args)).rows as T[]})})),close:()=>pg.close()};
 const repo=new KnowledgeRepository(db,{...scope,humanIds:[c.actor.id]});
 const claim=await repo.append(c,0,{id:'parent',expectedRevision:0,value:d.knowledge.records[0]!.value},'claim');
 const original=await repo.recordEvidenceLinks(c,0,d.source,{claim:claim.record,expectedRevision:0,links:d.links.records[0]!.links.map(({id,relation,selector})=>({id,relation,selector}))},'initial-links');
 const current=await repo.recordEvidenceLinks(c,1,d.source,{claim:claim.record,expectedRevision:1,links:[]},'remove-current');
 const selected={claim:claim.record,links:current.record},frame=await repo.prepareClaimDossier(c,selected);
 assert.deepEqual(parseSelectedDossierFrame(scope,selected,JSON.stringify(frame)),frame);assert.deepEqual(frame.sourceObligations[0]!.citationSet,original.record);
 await scoped(db,c,async tx=>assert.equal((await tx.audits()).filter(e=>e.type==='knowledge.claim-dossier.read_checked').length,1));
});
