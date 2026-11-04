import test from'node:test';import assert from'node:assert/strict';import{layoutWorkspace,renderWorkspace,validateSnapshot}from'../src/index.ts';import type{WorkspaceSnapshot}from'../src/index.ts';import type{Context}from'../src/contracts.ts';
const c:Context={tenantId:'alpha',projectId:'study',actor:{id:'reviewer',kind:'human',roles:['viewer']},purpose:'review',requestId:'r',now:'2026-01-01T00:00:00Z'};const ref=(id:string)=>({tenantId:'alpha',projectId:'study',kind:'task',id,revision:1});
const snapshot=():WorkspaceSnapshot=>({tenantId:'alpha',projectId:'study',schemaVersion:1,visibility:'private',title:'Fictional research workspace',capturedAt:c.now,nodes:[{ref:ref('a'),label:'Preserve source',kind:'task',state:'completed',stage:'tested',dependencies:[],summary:'Exact source preserved',details:{source:'fictional'}},{ref:ref('b'),label:'Evaluate account',kind:'task',state:'running',stage:'implemented',dependencies:[ref('a')],summary:'Comparing editions',details:{source:'fictional'}}],agents:[{id:'worker-1',name:'Fictional Worker',task:ref('b'),leaseExpiresAt:'2026-01-01T00:01:00Z',activitySummary:'Comparing two recorded editions'}],events:[]});
test('graph order is stable and each dependency is above its dependent',()=>{const s=snapshot(),a=layoutWorkspace(c,s),b=layoutWorkspace(c,{...s,nodes:[...s.nodes].reverse()});assert.deepEqual(a.nodes,b.nodes);assert.ok(a.nodes[0]!.y<a.nodes[1]!.y);assert.equal(a.edges.length,1);assert.equal(a.agents[0]!.active,true);});
test('stale task leases cannot be displayed as active workers',()=>{const a=layoutWorkspace({...c,now:'2026-01-01T00:02:00Z'},snapshot());assert.equal(a.agents[0]!.active,false);});
test('cross-tenant nodes dependencies agents and events fail closed',()=>{const s=snapshot();assert.throws(()=>validateSnapshot({...c,tenantId:'beta'},s));assert.throws(()=>validateSnapshot(c,{...s,nodes:s.nodes.map(n=>({...n,ref:{...n.ref,tenantId:'beta'}}))}));assert.throws(()=>validateSnapshot(c,{...s,events:[{id:'e',at:c.now,actorId:'a',action:'changed',resource:{...ref('a'),tenantId:'beta'},summary:'x'}]}));});
test('cycles missing dependencies duplicate nodes and reused agent labels are rejected',()=>{const s=snapshot();assert.throws(()=>layoutWorkspace(c,{...s,nodes:s.nodes.map(n=>n.ref.id==='a'?{...n,dependencies:[ref('b')]}:n)}),{code:'dependency_cycle'});assert.throws(()=>layoutWorkspace(c,{...s,nodes:[s.nodes[1]!]}),{code:'missing_dependency'});assert.throws(()=>layoutWorkspace(c,{...s,nodes:[...s.nodes,s.nodes[0]!]}));assert.throws(()=>layoutWorkspace(c,{...s,agents:[...s.agents,{...s.agents[0]!,id:'different'}]}));});
test('render escapes labels record JSON and script terminators',()=>{const s=snapshot();const marker='</script><script>globalThis.injected=true</script>';const html=renderWorkspace(c,{...s,title:'<unsafe title>',nodes:s.nodes.map((n,i)=>i? n:{...n,label:'<img src=x onerror=alert(1)>',details:{body:marker}})});assert.ok(!html.includes('<img src=x'));assert.ok(!html.includes(marker));assert.ok(html.includes('\\u003c/script>'));assert.ok(html.includes('&lt;unsafe title&gt;'));assert.ok(html.includes('Accessible record table'));assert.ok(html.includes('prefers-reduced-motion'));});

test('full layout is stable across equivalent node dependency and agent enumeration orders',()=>{
 const s=snapshot(),root=s.nodes[0]!,second={...root,ref:ref('c'),label:'Second root'},leaf={...s.nodes[1]!,dependencies:[root.ref,second.ref]};
 const a={...s,nodes:[root,second,leaf],agents:[s.agents[0]!,{...s.agents[0]!,id:'worker-2',name:'Other Worker',task:null,leaseExpiresAt:null}]};
 const b={...a,nodes:[{...leaf,dependencies:[second.ref,root.ref]},second,root],agents:[...a.agents].reverse()};
 assert.deepEqual(layoutWorkspace(c,a),layoutWorkspace(c,b));
});

test('returned node records are detached from later caller mutations',()=>{
 const s=snapshot(),layout=layoutWorkspace(c,s);s.nodes[0]!.label='changed';
 (s.nodes[0]!.details as {source:string}).source='changed';
 assert.equal(layout.nodes[0]!.node.label,'Preserve source');
 assert.deepEqual(layout.nodes[0]!.node.details,{source:'fictional'});
});

test('invalid current time is rejected even when no agents are present',()=>{
 assert.throws(()=>layoutWorkspace({...c,now:'not-a-time'},{...snapshot(),agents:[]}),{code:'invalid_time'});
});

test('render uses the admitted timeline snapshot rather than re-reading caller events',()=>{
 let reads=0;const base=snapshot();
 const s={...base,get events(){return ++reads<=2?[]:[{id:'foreign',at:c.now,actorId:'other',action:'private',resource:{...ref('foreign'),tenantId:'beta'},summary:'foreign private marker'}];}};
 const html=renderWorkspace(c,s);assert.equal(reads,1);assert.ok(!html.includes('foreign private marker'));
});
