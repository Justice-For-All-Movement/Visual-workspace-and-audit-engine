import type {CurrentClaimDossierReader} from "@accountability/knowledge-verification/dossier-source";
export type SelectedDossierFrame = Awaited<ReturnType<CurrentClaimDossierReader["read"]>>;
export type DossierScope=Readonly<{tenantId:string;projectId:string;purpose:string}>;
export type DossierRef=Readonly<{tenantId:string;projectId:string;kind:string;id:string;revision:number}>;
export type DossierSelection=Readonly<{claim:DossierRef;links:DossierRef}>;
export class DossierReadError extends Error { readonly code:string; constructor(code="invalid_response"){super(code);this.code=code;this.name="DossierReadError";} }
function require(value: unknown): asserts value {
  if (!value) throw new DossierReadError();
}
function exact(value: unknown, keys: readonly string[]): Record<string, any> {
  require(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === keys.length &&
      keys.every((k) => Object.hasOwn(value, k)),
  );
  return value as Record<string, any>;
}
function word(value: unknown, max = 128): asserts value is string {
  require(
    typeof value === "string" && value.length <= max && value.trim().length > 0,
  );
}
function integer(value: unknown, min = 1): asserts value is number {
  require(Number.isSafeInteger(value) && (value as number) >= min);
}
function ref(
  value: unknown,
  scope: DossierScope,
  kind?: string,
): DossierRef {
  const r = exact(value, ["tenantId", "projectId", "kind", "id", "revision"]);
  for (const key of ["tenantId", "projectId", "kind", "id"]) word(r[key]);
  integer(r.revision);
  require(
    r.tenantId === scope.tenantId &&
      r.projectId === scope.projectId &&
      (!kind || r.kind === kind),
  );
  return r as DossierRef;
}
function same(a: DossierRef, b: DossierRef) {
  return (
    a.tenantId === b.tenantId &&
    a.projectId === b.projectId &&
    a.kind === b.kind &&
    a.id === b.id &&
    a.revision === b.revision
  );
}
function predecessor(
  value: unknown,
  current: DossierRef,
  scope: DossierScope,
) {
  if (current.revision === 1) require(value === null);
  else {
    const p = ref(value, scope, current.kind);
    require(p.id === current.id && p.revision === current.revision - 1);
  }
}
function stamp(r: Record<string, any>) {
  word(r.actorId);
  word(r.requestId);
  require(
    typeof r.createdAt === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(r.createdAt) &&
      Number.isFinite(Date.parse(r.createdAt)) &&
      new Date(r.createdAt).toISOString() ===
        r.createdAt.replace(/Z$/, r.createdAt.includes(".") ? "Z" : ".000Z"),
  );
}
function hash(v: unknown) {
  require(typeof v === "string" && /^[a-f0-9]{64}$/.test(v));
}
function strings(value: unknown, max: number): string[] {
  require(
    Array.isArray(value) &&
      value.length <= max &&
      new Set(value).size === value.length,
  );
  for (const v of value) word(v);
  return value;
}
function selector(value: unknown, scope: DossierScope) {
  const kind = (value as any)?.kind;
  const base = ["evidence", "sha256", "kind"],
    anchor = [...base, "representationId", "representationDigest"];
  require(["whole", "text", "page", "time"].includes(kind));
  const s = exact(
    value,
    kind === "whole"
      ? base
      : kind === "text"
        ? [...anchor, "page", "start", "end", "quote"]
        : kind === "page"
          ? [...anchor, "fromPage", "toPage"]
          : [...anchor, "startMs", "endMs"],
  );
  ref(s.evidence, scope, "evidence");
  hash(s.sha256);
  if (kind === "whole") return;
  word(s.representationId);
  hash(s.representationDigest);
  if (kind === "text") {
    if (s.page !== null) integer(s.page);
    integer(s.start, 0);
    integer(s.end);
    word(s.quote, 16000);
    require(s.end > s.start && s.end-s.start === s.quote.length && new TextDecoder("utf-8",{fatal:true}).decode(new TextEncoder().encode(s.quote))===s.quote);
  } else if (kind === "page") {
    integer(s.fromPage);
    integer(s.toPage);
    require(s.toPage >= s.fromPage);
  } else {
    integer(s.startMs, 0);
    integer(s.endMs);
    require(s.endMs > s.startMs);
  }
}
function stable(v:any):string {return JSON.stringify(v===null||typeof v!=="object"?v:Array.isArray(v)?v.map(x=>JSON.parse(stable(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(stable(v[k]))])));}
function list(v:unknown,max:number):asserts v is any[]{require(Array.isArray(v)&&v.length<=max);}
function own(v:unknown,keys:string[]):Record<string,unknown>{
 require(v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===keys.length);
 const copy:Record<string,unknown>={};for(const k of keys){const d=Object.getOwnPropertyDescriptor(v,k);require(d&&'value'in d&&d.enumerable);copy[k]=d.value;}return copy;
}
export function captureDossierSelection(scope:DossierScope,input:DossierSelection):DossierSelection{
 const q=own(input,['claim','links']);word(scope.tenantId);word(scope.projectId);word(scope.purpose,128);
 const copy=(v:unknown,kind:string)=>({...ref(own(v,['tenantId','projectId','kind','id','revision']),scope,kind)});
 const out={claim:copy(q.claim,'claim'),links:copy(q.links,'knowledge-evidence-links')};
 require(out.claim.id===out.links.id&&new TextEncoder().encode(JSON.stringify(out)).length<=1024);return out;
}
function range(v:unknown){const t=exact(v,['earliest','latest']);for(const x of [t.earliest,t.latest])if(x!==null){word(x,24);require(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x.replace(/Z$/,x.includes('.')?'Z':'.000Z'));}require(t.earliest===null||t.latest===null||Date.parse(t.earliest)<=Date.parse(t.latest));}
function references(v:unknown,s:DossierScope,kinds:string[]){list(v,128);const seen=new Set<string>();for(const x of v){const r=ref(x,s);require(kinds.includes(r.kind)&&!seen.has(stable(r)));seen.add(stable(r));}}
function limitations(v:unknown){list(v,64);for(const x of v)word(x,2000);}
function record(v:unknown,s:DossierScope,count:number){
 const r=exact(v,['ref','supersedes','visibility','createdAt','actorId','actorKind','requestId','purpose','value']);const rr=ref(r.ref,s);
 require(['claim','entity','event','relationship'].includes(rr.kind)&&rr.revision<=count&&r.visibility==='private'&&r.purpose===s.purpose&&['human','agent','service'].includes(r.actorKind));stamp(r);predecessor(r.supersedes,rr,s);
 const x=r.value;require(x&&x.type===rr.kind);
 if(x.type==='entity'){exact(x,['type','label','category','description']);word(x.label,500);word(x.description,8000);require(['person','organization','place','object','unknown'].includes(x.category));}
 else if(x.type==='event'){exact(x,['type','label','description','time','entityRefs']);word(x.label,500);word(x.description,8000);range(x.time);references(x.entityRefs,s,['entity']);}
 else {require(x.assessment===null&&x.proceduralPosture===null&&x.editorialApproval===null);limitations(x.limitations);range(x.time);
  if(x.type==='claim'){exact(x,['type','text','subjectRefs','time','accountType','limitations','assessment','proceduralPosture','editorialApproval']);word(x.text,16000);references(x.subjectRefs,s,['entity','event','relationship']);require(['attributed_testimony','document_assertion','observation','research_inference'].includes(x.accountType));}
  else {exact(x,['type','relationshipType','label','from','to','time','limitations','assessment','proceduralPosture','editorialApproval']);word(x.label,500);require(['role_assertion','association'].includes(x.relationshipType));references([x.from],s,['entity']);references([x.to],s,['entity','event']);require(!same(x.from,x.to));}
 }return r;
}
function link(v:unknown,s:DossierScope){const l=exact(v,['id','relation','selector','family','fingerprint']);word(l.id);require(['supports','challenges','quotes'].includes(l.relation));selector(l.selector,s);hash(l.fingerprint);const f=exact(l.family,['familyId','roots','basisDigest']);if(f.familyId!==null)word(f.familyId);strings(f.roots,128);hash(f.basisDigest);return l;}
/** Bounded wire consistency only; unloaded complete prefixes/bytes/policy/audits are never reconstructed. */
export function parseSelectedDossierFrame(scope:DossierScope,selected:DossierSelection,text:string):SelectedDossierFrame{
 try {
 const choice=captureDossierSelection(scope,selected);require(typeof text==='string'&&text.length<=524288&&new TextEncoder().encode(text).length<=524288);
 const f=exact(JSON.parse(text),['profile','knowledgeStorage','linksStorage','dossier','sourceObligations']);require(f.profile==='owning-claim-dossier-v1');
 const ks=ref(f.knowledgeStorage,scope,'knowledge-history'),ls=ref(f.linksStorage,scope,'knowledge-evidence-links-history');
 require(ks.id==='d97c9fd3ece7bae9bb5f49b2cb969e18ee8aa4b1b28820dcbb945a10c8eb2521'&&ls.id==='dc370fa4cd3fe8664390b835bccdc51c541f08ee684d18d9a5c4980e49f32c91'&&ks.revision<=2048&&ls.revision<=512);
 const d=exact(f.dossier,['schemaVersion','profile','tenantId','projectId','visibility','purpose','basis','claim','citations','historicalChallenges','subjects','unloaded']);
 require(d.schemaVersion===1&&d.profile==='captured-claim-dossier-v1'&&d.visibility==='private'&&d.tenantId===scope.tenantId&&d.projectId===scope.projectId&&d.purpose===scope.purpose);
 const b=exact(d.basis,['knowledgeRecordCount','linksRecordCount','claim','links']);require(b.knowledgeRecordCount===ks.revision&&b.linksRecordCount===ls.revision&&same(ref(b.claim,scope,'claim'),choice.claim)&&same(ref(b.links,scope,'knowledge-evidence-links'),choice.links));
 const c=record(d.claim,scope,ks.revision);require(same(c.ref,choice.claim));
 const l=exact(d.citations,['ref','supersedes','claim','visibility','actorId','actorKind','createdAt','requestId','purpose','links']);
 require(same(ref(l.ref,scope,'knowledge-evidence-links'),choice.links)&&same(ref(l.claim,scope,'claim'),choice.claim)&&l.ref.revision<=ls.revision&&l.visibility==='private'&&l.purpose===scope.purpose&&['human','agent','service'].includes(l.actorKind));stamp(l);predecessor(l.supersedes,l.ref,scope);list(l.links,64);
 const ids=new Set<string>(),selectors=new Set<string>();for(const item of l.links){const x=link(item,scope),key=stable([x.relation,x.selector]);require(!ids.has(x.id)&&!selectors.has(key));ids.add(x.id);selectors.add(key);}
 list(d.historicalChallenges,256);
 let prior=0;
 const historical=new Set<string>();
 const groups=new Map<string,{claim:string;selectors:Set<string>;count:number}>();
 for(const item of d.historicalChallenges){
   const h=exact(item,['citationSet','claim','link']);
   const r=ref(h.citationSet,scope,'knowledge-evidence-links');
   const cr=ref(h.claim,scope,'claim'),x=link(h.link,scope),key=stable([r,x.id]);
   require(r.id===choice.links.id&&r.revision>=prior&&r.revision<choice.links.revision&&
     cr.id===choice.claim.id&&cr.revision<=choice.claim.revision&&x.relation==='challenges'&&!historical.has(key));
   const groupKey=stable(r),selectorKey=stable(x.selector),group=groups.get(groupKey);
   if(group){require(group.claim===stable(cr)&&group.count<64&&!group.selectors.has(selectorKey));group.count++;group.selectors.add(selectorKey);}
   else groups.set(groupKey,{claim:stable(cr),selectors:new Set([selectorKey]),count:1});
   historical.add(key);prior=r.revision;
 }
 list(d.subjects,128);require(d.subjects.length===c.value.subjectRefs.length);for(const [i,item]of d.subjects.entries()){const s=exact(item,['record','latestObserved','status']),r=record(s.record,scope,ks.revision),latest=ref(s.latestObserved,scope,r.ref.kind);require(same(r.ref,c.value.subjectRefs[i])&&latest.id===r.ref.id&&latest.revision>=r.ref.revision&&latest.revision<=ks.revision&&s.status===(same(latest,r.ref)?'same-edition':'changed-in-capture'));}
 require(stable(d.unloaded)===stable(['evidence-bytes','current-source-permissions','verification-reviews','raw-audit-events']));
 const observations=[...l.links.map((x:any)=>({citationSet:l.ref,linkId:x.id,selector:x.selector})),...d.historicalChallenges.map((h:any)=>({citationSet:h.citationSet,linkId:h.link.id,selector:h.link.selector}))];require(observations.length<=256&&stable(f.sourceObligations)===stable(observations));return f as SelectedDossierFrame;
 }catch{throw new DossierReadError();}
}
/** Literal private table and metadata inspector. No active markup, external assets, generated audit or permission claims. */
export function renderSelectedDossierFrame(document:Document,scope:DossierScope,selected:DossierSelection,text:string):HTMLElement{
 const f=parseSelectedDossierFrame(scope,selected,text),root=document.createElement('section');root.setAttribute('aria-label','Private unassessed claim dossier');
 const add=(tag:string,text:string)=>{const e=document.createElement(tag);e.textContent=text;root.append(e);};
 add('h2','Private unassessed claim dossier');add('p',f.dossier.claim.value.type==='claim'?f.dossier.claim.value.text:'');
 add('p','Current and historical citations are retained. This copy is not authentication, current permission, work proof, findings, answers or closure. Full history prefixes, bytes and audits are not loaded.');
 add('p',`Observed containing revisions: Knowledge ${f.knowledgeStorage.revision}; citations ${f.linksStorage.revision}. These are not creation editions.`);
 add('p',`Current citations: ${f.dossier.citations.links.length}; retained historical challenges: ${f.dossier.historicalChallenges.length}.`);
 const table=document.createElement('table'),caption=document.createElement('caption');caption.textContent='All current citations and retained historical challenges';table.append(caption);
 const head=document.createElement('thead'),heading=document.createElement('tr'),body=document.createElement('tbody');
 for(const label of ['Observation','Link','Relation','Citation edition','Selector']){const cell=document.createElement('th');cell.scope='col';cell.textContent=label;heading.append(cell);}head.append(heading);table.append(head,body);
 for(const [kind,items] of [['Current',f.dossier.citations.links.map(link=>({citationSet:f.dossier.citations.ref,link}))],['Historical challenge',f.dossier.historicalChallenges]] as const){for(const item of items){const row=document.createElement('tr');for(const text of [kind,item.link.id,item.link.relation,JSON.stringify(item.citationSet),JSON.stringify(item.link.selector)]){const cell=document.createElement('td');cell.textContent=text;row.append(cell);}body.append(row);}}
 root.append(table);const metadata=JSON.stringify(f,null,2);require(new TextEncoder().encode(metadata).length<=2*1024*1024);add('pre',metadata);return root;
}
