import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderWorkspace } from '../src/index.ts';
import type { WorkspaceSnapshot } from '../src/index.ts';
import type { Context } from '../src/contracts.ts';
const context: Context = {tenantId:'alpha',projectId:'study',actor:{id:'reviewer',kind:'human',roles:['viewer']},purpose:'review',requestId:'dom-test',now:'2026-01-01T00:00:00Z'};
function fixture(): WorkspaceSnapshot {const a={tenantId:'alpha',projectId:'study',kind:'task',id:'a',revision:1};const b={...a,id:'b'};return{tenantId:'alpha',projectId:'study',schemaVersion:1,visibility:'private',title:'Fictional workspace',capturedAt:context.now,nodes:[{ref:b,label:'Dependent task',kind:'task',state:'pending',stage:'pending',dependencies:[a],summary:'Second in graph',details:{marker:'dependent'}},{ref:a,label:'Original source',kind:'source',state:'preserved',stage:'tested',dependencies:[],summary:'First in graph',details:{marker:'original',text:'</script><script>window.injected=true</script>'}}],agents:[],events:[]};}
function document(){const dom=new JSDOM(renderWorkspace(context,fixture()),{runScripts:'dangerously'});dom.window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};dom.window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};return dom;}
test('graph and accessible table select the same exact record even when input order differs',()=>{const dom=document(),d=dom.window.document;for(const element of [d.querySelector('g[data-node="0"]'),d.querySelector('tbody button[data-node="0"]')]){element!.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));assert.equal(d.querySelector('#detail-title')!.textContent,'Original source');assert.match(d.querySelector('#detail')!.textContent!,/"marker": "original"/);}assert.equal((dom.window as unknown as Record<string,unknown>).injected,undefined);dom.window.close();});
test('SVG keyboard action opens the inspector and close returns it to a closed state',()=>{const dom=document(),d=dom.window.document;d.querySelector('g[data-node="1"]')!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));assert.ok(d.querySelector('dialog[open]'));assert.equal(d.querySelector('#detail-title')!.textContent,'Dependent task');(d.querySelector('#close')as HTMLElement).click();assert.equal(d.querySelector('dialog[open]'),null);dom.window.close();});


test('timeline inspector preserves actual event and exact containing resource without requiring a graph node', () => {
 const s=fixture();const resource={tenantId:context.tenantId,projectId:context.projectId,kind:'aggregate',id:'actual-ledger',revision:7};
 const event={id:'event-2',at:context.now,actorId:'actual-actor',action:'Observed change',resource,summary:'Literal host-projected event; no invented edition'};
 const dom=new JSDOM(renderWorkspace(context,{...s,events:[event]}),{runScripts:'dangerously'});
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
 const d=dom.window.document;(d.querySelector('[data-event]') as HTMLElement).click();
 assert.equal(d.querySelector('#detail-title')!.textContent,'Timeline event event-2');
 assert.deepEqual(JSON.parse(d.querySelector('#detail')!.textContent!),event);
 assert.equal(d.querySelectorAll('g[data-event]').length,0);
 assert.equal(d.querySelector('[data-event]')!.tagName,'BUTTON');dom.window.close();
});
test('same-time timeline events have stable ID order and inert literal event data', () => {
 const s=fixture(),marker='</script><script>window.eventInjected=true</script>';
 const a={id:'a',at:context.now,actorId:'actor',action:'<img src=x onerror=alert(1)>',resource:s.nodes[0]!.ref,summary:marker},b={...a,id:'b'};
 const first=renderWorkspace(context,{...s,events:[b,a]}),second=renderWorkspace(context,{...s,events:[a,b]});
 assert.equal(first,second);assert.ok(!first.includes(marker));
 const dom=new JSDOM(first,{runScripts:'dangerously'});dom.window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
 const d=dom.window.document;(d.querySelector('[data-event="0"]') as HTMLElement).click();
 assert.equal(d.querySelector('#detail-title')!.textContent,'Timeline event a');
 assert.equal(JSON.parse(d.querySelector('#detail')!.textContent!).summary,marker);
 assert.equal((dom.window as unknown as Record<string,unknown>).eventInjected,undefined);assert.equal(d.querySelector('img'),null);dom.window.close();
});
test('timeline event actors summaries and foreign resources fail closed before rendering', () => {
 const s=fixture(),e={id:'e',at:context.now,actorId:'actor',action:'change',resource:s.nodes[0]!.ref,summary:'literal'};
 for(const event of [{...e,credential:'must-not-export'}, {...e,actorId:''},{...e,actorId:'x'.repeat(129)},{...e,summary:'x'.repeat(4001)},{...e,summary:null},{...e,resource:{...e.resource,projectId:'foreign'}}])
  assert.throws(()=>renderWorkspace(context,{...s,events:[event as never]}));
});
