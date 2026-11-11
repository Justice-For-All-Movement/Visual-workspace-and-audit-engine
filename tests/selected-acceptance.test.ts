import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {acceptanceFrameFixture} from './selected-acceptance-fixture.ts';
import {parseSelectedAcceptanceFrame,renderSelectedAcceptanceFrame,captureAcceptanceSelection} from '../src/selected-acceptance.ts';
import {AcceptanceReadClient} from '../src/acceptance-client.ts';
import {mountAcceptanceRead} from '../src/acceptance-controls.ts';
const origin='https://private.invalid';
const json=(v:unknown)=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json','cache-control':'no-store'}});
test('selected acceptance preserves actual domain receipt and observed containing editions without invented histories',()=>{
 const {scope,selected,frame}=acceptanceFrameFixture();
 assert.deepEqual(parseSelectedAcceptanceFrame(scope,selected,JSON.stringify(frame)),frame);
 const later=structuredClone(frame);later.knowledgeStorage.revision=9;later.linksStorage.revision=8;
 assert.equal(parseSelectedAcceptanceFrame(scope,selected,JSON.stringify(later)).record.parentKnowledgeRevision,1);
});
test('selected acceptance denies foreign or inconsistent metadata, truth tracks, support transfer and broken UTF16 excerpts',()=>{
 const {scope,selected,frame}=acceptanceFrameFixture();
 const changes=[(f:any)=>f.record.capturedEvidenceRevision=null,(f:any)=>f.citation.links[0].relation='supports',
 (f:any)=>f.claim.value.assessment='verified',(f:any)=>f.record.parentKnowledgeRevision=8,
 (f:any)=>f.record.excerpt.quote='invented',(f:any)=>f.claim.ref.projectId='elsewhere',
 (f:any)=>f.citation.actorId='other',(f:any)=>f.record.actorId='other',(f:any)=>f.history=[],
 (f:any)=>f.citation.links[0].family.extra='authority',(f:any)=>f.record.createdAt='2026-02-30T00:00:00Z',
 (f:any)=>{f.record.excerpt.end=2;f.record.excerpt.quote='\ud83d';}];
 for(const change of changes){const f=structuredClone(frame);change(f);assert.throws(()=>parseSelectedAcceptanceFrame(scope,selected,JSON.stringify(f)));}
 let reads=0;const choice={...selected};Object.defineProperty(choice,'id',{enumerable:true,get(){reads++;return selected.id;}});
 assert.throws(()=>captureAcceptanceSelection(scope,choice));assert.equal(reads,0);
 assert.throws(()=>parseSelectedAcceptanceFrame(scope,selected,'x'.repeat(512*1024+1)));
});
test('acceptance rendering is inert literal text with unloaded parent/source/audit and no synthetic creation claims',()=>{
 const {scope,selected,frame}=acceptanceFrameFixture();(frame.claim.value as any).text='<img src=x onerror=alert(1)> $&';
 const dom=new JSDOM('<main></main>',{url:origin});const view=renderSelectedAcceptanceFrame(dom.window.document,scope,selected,JSON.stringify(frame));
 dom.window.document.querySelector('main')!.append(view);assert.equal(view.querySelectorAll('img,script,a,iframe').length,0);
 assert(view.textContent!.includes('<img src=x onerror=alert(1)> $&'));assert(view.textContent!.includes('not creation editions'));
});
test('explicit read obtains fresh session CSRF and exact selection, preserves private transport options and closes signals',async()=>{
 const {scope,selected,frame}=acceptanceFrameFixture(),calls:{url:string,init:RequestInit}[]=[];
 const client=new AcceptanceReadClient(origin,scope,'review',(async(url,init)=>{calls.push({url:String(url),init:init!});return json(String(url).endsWith('/session')?{actorId:'human',csrfToken:'s'.repeat(32)}:frame);}) as typeof fetch);
 assert.equal(calls.length,0);assert.deepEqual(await client.read(selected),frame);
 assert.equal(calls.length,2);assert.equal(calls[1]!.url,origin+'/private/proposal-acceptance/read');
 assert.deepEqual(JSON.parse(calls[1]!.init.body as string),{selected});
 for(const c of calls){assert.equal(c.init.credentials,'same-origin');assert.equal(c.init.redirect,'error');assert.equal(c.init.cache,'no-store');assert(c.init.signal!.aborted);}
 client.dispose();assert(client.closed);
});
test('actor changes permanently close client before a second read POST',async()=>{
 const {scope,selected,frame}=acceptanceFrameFixture();let actor='first',posts=0;
 const client=new AcceptanceReadClient(origin,scope,'review',(async(url)=>{if(String(url).endsWith('/session'))return json({actorId:actor,csrfToken:'s'.repeat(32)});posts++;return json(frame);}) as typeof fetch);
 await client.read(selected);actor='second';await assert.rejects(client.read(selected));assert(client.closed);assert.equal(posts,1);
});
test('mounted acceptance read is explicit, exclusive and clears literal views on disposal',async()=>{
 const {scope,selected,frame}=acceptanceFrameFixture(),dom=new JSDOM('<main></main>',{url:origin});let calls=0;
 const client=new AcceptanceReadClient(origin,scope,'review',(async(url)=>{calls++;return json(String(url).endsWith('/session')?{actorId:'human',csrfToken:'s'.repeat(32)}:frame);}) as typeof fetch);
 const root=dom.window.document.querySelector('main')!,controls=mountAcceptanceRead(root,client,selected);
 assert.equal(calls,0);assert.throws(()=>mountAcceptanceRead(root,client,selected));
 root.querySelector('button')!.click();for(let n=0;n<20&&!root.querySelector('blockquote');n++)await new Promise(r=>setTimeout(r,5));
 assert(root.querySelector('blockquote'));assert.equal(calls,2);controls.dispose();assert.equal(root.children.length,0);assert(client.closed);
});
test('client withholds malformed, wrong-purpose and over-budget private replies',async()=>{
 const {scope,selected,frame}=acceptanceFrameFixture();
 const altered:any=structuredClone(frame);altered.record.purpose='other';altered.claim.purpose='other';altered.citation.purpose='other';
 const replies=[()=>json({...frame,permit:true}),()=>json(altered),()=>new Response(new Uint8Array([0xff]),{headers:{'content-type':'application/json','cache-control':'no-store'}}),()=>new Response('x'.repeat(512*1024+1),{headers:{'content-type':'application/json','cache-control':'no-store'}})];
 for(const reply of replies){const client=new AcceptanceReadClient(origin,scope,'review',(async(url)=>String(url).endsWith('/session')?json({actorId:'human',csrfToken:'s'.repeat(32)}):reply()) as typeof fetch);await assert.rejects(client.read(selected));client.dispose();}
});
test('disposal fences a noncooperative late read and cancels its response body',async()=>{
 const {scope,selected,frame}=acceptanceFrameFixture();let release!:(r:Response)=>void,started=false,cancelled=false;
 const client=new AcceptanceReadClient(origin,scope,'review',(async(url)=>{
  if(String(url).endsWith('/session'))return json({actorId:'human',csrfToken:'s'.repeat(32)});
  started=true;return new Promise<Response>(resolve=>{release=resolve;});
 }) as typeof fetch);
 const pending=client.read(selected);for(let n=0;n<30&&!started;n++)await new Promise(r=>setTimeout(r,1));assert(started);
 client.dispose();await assert.rejects(pending);
 release(new Response(new ReadableStream({start(s){s.enqueue(Buffer.from(JSON.stringify(frame)));},cancel(){cancelled=true;}}),{headers:{'content-type':'application/json','cache-control':'no-store'}}));
 await new Promise(r=>setTimeout(r,1));assert(cancelled);assert(client.closed);
});
