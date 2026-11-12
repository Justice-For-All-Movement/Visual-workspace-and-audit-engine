import {acceptanceDomain,c} from './selected-acceptance-fixture.ts';
import {createCapturedClaimDossier} from '@accountability/knowledge-verification/claim-dossier';
import {reviseEvidenceLinks} from '@accountability/knowledge-verification/evidence-links';
import {KNOWLEDGE_KIND,KNOWLEDGE_KEY,EVIDENCE_LINKS_KIND,EVIDENCE_LINKS_KEY} from '@accountability/knowledge-verification/repository';
export function dossierFixture(){
 const d=acceptanceDomain(true),links=reviseEvidenceLinks(c,d.knowledge,d.source,d.links,{claim:d.knowledge.records[0]!.ref,expectedRevision:1,links:[]});
 const selected={claim:d.knowledge.records[0]!.ref,links:links.records.at(-1)!.ref};
 const dossier=createCapturedClaimDossier(c,JSON.stringify({knowledge:d.knowledge,links}),selected);
 const frame={profile:'owning-claim-dossier-v1' as const,knowledgeStorage:{...selected.claim,kind:KNOWLEDGE_KIND,id:KNOWLEDGE_KEY,revision:1},linksStorage:{...selected.links,kind:EVIDENCE_LINKS_KIND,id:EVIDENCE_LINKS_KEY,revision:2},dossier,
  sourceObligations:dossier.historicalChallenges.map(h=>({citationSet:h.citationSet,linkId:h.link.id,selector:h.link.selector}))};
 return {scope:{tenantId:c.tenantId,projectId:c.projectId,purpose:c.purpose},selected,frame,d,links};
}
