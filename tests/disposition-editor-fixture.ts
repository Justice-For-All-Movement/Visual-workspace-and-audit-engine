import test from 'node:test';
import assert from 'node:assert/strict';
import {ready,c,origin} from './disposition-http-fixture.ts';
import {IdentityQuestionDispositionRepository} from '@accountability/factual-investigation/disposition-identity';
import {createDispositionWriteHandler} from '@accountability/factual-investigation/disposition-write-http';
import {DISPOSITION_KEY} from '@accountability/factual-investigation/disposition-repository';
import {DispositionWriteClient} from '../src/disposition-write-client.ts';
export async function fixture(t: test.TestContext) {
 const f=await ready(t);
 const write=createDispositionWriteHandler(new IdentityQuestionDispositionRepository(f.store,f.membership,f.fixed),f.membership,{authenticate:async()=>({actorId:c.actor.id,requestId:c.requestId,csrfToken:'fixture-csrf-token-0000000000000000000000'})},{...f.fixed,origin},()=>c.now);
 const calls: {url:string,body:string|undefined}[]=[];
 const state={lose:false,reject:false,actor:false,corrupt:false};
 const client=new DispositionWriteClient(origin,c,c.purpose,async(url,init)=>{
   calls.push({url:String(url),body:init?.body as string|undefined});
   if(state.actor && String(url).endsWith('/disposition-write/session')) return new Response(JSON.stringify({actorId:'different-human',csrfToken:'fixture-csrf-token-0000000000000000000000'}),{headers:{'content-type':'application/json','cache-control':'no-store'}});
   const response=await (String(url).includes('/disposition-write/')?write:f.handler)(new Request(String(url),init));
   if(String(url).endsWith('/disposition-write/record')) {
     if(state.lose){state.lose=false;throw Error('lost network acknowledgement');}
     if(state.reject) return new Response('{}',{status:503});
     if(state.corrupt) {const a=await response.json();a.planningStorage.revision++;return new Response(JSON.stringify(a),{headers:{'content-type':'application/json','cache-control':'no-store'}});}
   }
   return response;
 });
 t.after(()=>client.dispose());return {...f,client,calls,state};
}
