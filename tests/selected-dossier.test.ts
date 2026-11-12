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
 (f:any)=>f.dossier.historicalChallenges[0].link.selector.end=3,(f:any)=>f.dossier.historicalChallenges.push(f.dossier.historicalChallenges[0])];
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
