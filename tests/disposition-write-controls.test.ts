import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {fixture} from './disposition-editor-fixture.ts';
import {c,origin} from './disposition-http-fixture.ts';
import {mountDispositionWrite} from '../src/disposition-write-controls.ts';
async function ready(t:test.TestContext) {
 const f=await fixture(t),dom=new JSDOM('<main></main>',{url:origin}),root=dom.window.document.querySelector('main')!;
 const ids={commands:0,reviews:0};const view=mountDispositionWrite(root,f.client,f.ack.record,()=>`command-${++ids.commands}`,()=>`review-${++ids.reviews}`);
 t.after(()=>{view.dispose();dom.window.close();});
 const button=(name:string)=>Array.from(root.querySelectorAll('button')).find(x=>x.textContent!.includes(name))!;
 const input=(name:string)=>root.querySelector(`[name="${name}"]`) as HTMLInputElement;
 const change=(name:string,value:string)=>{input(name).value=name==='reopeningTriggers'?JSON.stringify([value]):value;input(name).dispatchEvent(new dom.window.Event('input',{bubbles:true}));};
 const idle=async()=>{for(let i=0;i<1000&&(f.client.busy||button('Read')?.disabled&&root.textContent?.includes('Reading'));i++)await new Promise(r=>setTimeout(r,5));await new Promise(r=>setTimeout(r,0));};
 const read=async()=>{button('Read').click();await idle();assert.ok(root.querySelector('table'));};
 return {...f,dom,root,view,button,input,change,read,idle,ids};
}
test('actual mounted editor is inert, requires confirmation, protects dirty reload, writes then explicitly rereads same plan',async t=>{
 const f=await ready(t);assert.equal(f.calls.length,0);assert.equal(f.button('Record').disabled,true);
 await f.read();assert.equal(f.input('confirm').checked,false);
 f.change('time:reason','Unanswered pending authorized check');assert.equal(f.button('Read').disabled,true);
 const calls=f.calls.length;f.button('Read').dispatchEvent(new f.dom.window.Event('click'));assert.equal(f.calls.length,calls);
 f.button('Record').dispatchEvent(new f.dom.window.Event('click'));assert.equal(f.ids.commands,0);
 f.change('time:status','unresolved');f.change('reopeningTriggers','New authorized record');
 f.input('confirm').click();f.button('Record').click();await f.idle();
 assert.equal(f.ids.commands,1);assert.equal(f.ids.reviews,1);assert.equal(f.client.pending,null);assert.equal(f.root.querySelector('table'),null);
 assert.ok(f.root.textContent!.includes('Write acknowledged'));assert.equal(f.button('Read').disabled,false);
 await f.read();assert.equal(f.client.viewed!.table.history.length,2);assert.equal(f.client.viewed!.table.questions[0]!.disposition.status,'unresolved');
});
test('lost actual ACK locks edit/read/discard and manual identical replay makes one review without regenerating IDs',async t=>{
 const f=await ready(t);await f.read();f.change('time:status','deferred');f.change('time:reviewAt','2026-03-01T00:00:00.000Z');f.change('time:reason','Wait for authorized fixture');f.change('reopeningTriggers','Authorized fixture available');
 f.input('confirm').click();f.state.lose=true;f.button('Record').click();await f.idle();assert.ok(f.client.pending);
 assert.equal(f.button('Read').disabled,true);assert.equal(f.button('Discard').disabled,true);assert.equal(f.button('Record').disabled,true);
 const before=f.calls.length;f.button('Read').dispatchEvent(new f.dom.window.Event('click'));f.button('Discard').dispatchEvent(new f.dom.window.Event('click'));assert.equal(f.calls.length,before);
 f.button('Replay').click();await f.idle();assert.equal(f.ids.commands,1);assert.equal(f.ids.reviews,1);
 const posts=f.calls.filter(x=>x.url.endsWith('/record'));assert.equal(posts.length,2);assert.equal(posts[0]!.body,posts[1]!.body);
 await f.read();assert.equal(f.client.viewed!.table.history.length,2);assert.equal(f.client.viewed!.table.latestReview!.questions[0]!.status,'deferred');
});
test('current withdrawal clears old view on read and pending actor change closes before replay POST',async t=>{
 const f=await ready(t);await f.read();await f.membership.setResourcePolicy(c,1,{...f.policy,memberIds:[]},'withdraw');f.button('Read').click();assert.equal(f.root.querySelector('table'),null);await f.idle();assert.equal(f.root.querySelector('table'),null);
 const g=await ready(t);await g.read();g.change('reopeningTriggers','New record');g.input('confirm').click();g.state.lose=true;g.button('Record').click();await g.idle();const before=g.calls.filter(x=>x.url.endsWith('/record')).length;
 g.state.actor=true;g.button('Replay').click();await g.idle();assert.equal(g.client.closed,true);assert.equal(g.root.textContent,'');assert.equal(g.calls.filter(x=>x.url.endsWith('/record')).length,before);
});
test('exclusive ownership, direct detach and host ID callback disposal fence dispatch',async t=>{
 const f=await ready(t);assert.throws(()=>mountDispositionWrite(f.root,f.client,f.ack.record,()=> 'x',()=> 'y'));await f.read();f.input('time:reason').remove();f.button('Record').dispatchEvent(new f.dom.window.Event('click'));await new Promise(r=>setTimeout(r,0));assert.equal(f.client.closed,true);assert.equal(f.root.textContent,'');
 const g=await fixture(t),dom=new JSDOM('<main></main>',{url:origin}),root=dom.window.document.querySelector('main')!;
 let dispose=()=>{};const view=mountDispositionWrite(root,g.client,g.ack.record,()=>{dispose();return 'x';},()=>{throw Error('must not call');});dispose=view.dispose;t.after(()=>{view.dispose();dom.window.close();});
 root.querySelector('button')!.click();for(let i=0;i<1000&&!root.querySelector('table');i++)await new Promise(r=>setTimeout(r,5));
 (root.querySelector('[name="confirm"]') as HTMLInputElement).click();const record=Array.from(root.querySelectorAll('button')).find(x=>x.textContent!.includes('Record'))!;record.click();await new Promise(r=>setTimeout(r,0));assert.equal(g.client.closed,true);assert.equal(g.calls.filter(x=>x.url.endsWith('/record')).length,0);assert.equal(root.textContent,'');
});
test('literal multiline trigger survives unchanged; editing resets confirmation and discard restores captured values',async t=>{
 const f=await ready(t);await f.read();const original=f.input('time:reason').value;
 f.input('confirm').click();assert.equal(f.input('confirm').checked,true);
 f.change('time:reason','Changed rationale');assert.equal(f.input('confirm').checked,false);assert.equal(f.button('Record').disabled,true);
 f.button('Discard').click();assert.equal(f.input('time:reason').value,original);assert.equal(f.input('confirm').checked,false);
 const literal='Line one\nLine two <script>literal</script> λ';f.change('reopeningTriggers',literal);f.input('confirm').click();f.button('Record').click();await f.idle();await f.read();
 assert.deepEqual(f.client.viewed!.table.latestReview!.reopeningTriggers,[literal]);assert.deepEqual(JSON.parse(f.input('reopeningTriggers').value),[literal]);assert.equal(f.root.querySelector('script'),null);
});
test('detaching during a noncooperative read closes client and withholds late private frame',async t=>{
 const f=await fixture(t);const frame=await f.client.load(f.ack.record);
 const {DispositionWriteClient}=await import('../src/disposition-write-client.ts');
 let release!:(r:Response)=>void,began!:()=>void,cancelled=false;const started=new Promise<void>(r=>began=r);
 const client=new DispositionWriteClient(origin,c,c.purpose,async(url)=>{
  if(String(url).endsWith('/read')){began();return new Promise<Response>(r=>release=r);}
  return new Response(JSON.stringify({actorId:c.actor.id,csrfToken:'fixture-csrf-token-0000000000000000000000'}),{headers:{'content-type':'application/json','cache-control':'no-store'}});
 });
 const dom=new JSDOM('<main></main>',{url:origin}),root=dom.window.document.querySelector('main')!;
 const view=mountDispositionWrite(root,client,f.ack.record,()=> 'x',()=> 'y');t.after(()=>{view.dispose();dom.window.close();});
 root.querySelector('button')!.click();await started;root.remove();await new Promise(r=>setTimeout(r,0));assert.equal(client.closed,true);
 const bytes=new TextEncoder().encode(JSON.stringify(frame));release(new Response(new ReadableStream({start(controller){controller.enqueue(bytes);},cancel(){cancelled=true;}}),{headers:{'content-type':'application/json','cache-control':'no-store'}}));
 await new Promise(r=>setTimeout(r,0));assert.equal(cancelled,true);assert.equal(root.textContent,'');assert.equal(client.viewed,null);
});
