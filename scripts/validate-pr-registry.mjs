import {readFile} from 'node:fs/promises';
import {parsePrRegistry} from '../registry/pr-contract.mjs';
const body = await readFile(new URL('../registry/prs.json', import.meta.url), 'utf8');
const repository = process.env.GITHUB_REPOSITORY || JSON.parse(body).repository;
const {document} = parsePrRegistry(body, repository);
const retired = JSON.parse(await readFile(new URL('../registry/roadmap.json', import.meta.url), 'utf8'));
if (retired.repository !== repository || retired.deprecated !== true || retired.redirectTo !== 'registry/prs.json' ||
    Object.hasOwn(retired, 'milestones') || Object.hasOwn(retired, 'units') || Object.hasOwn(retired, 'plannedPrCount'))
  throw new Error('Only registry/prs.json may contain the active PR plan');
console.log(`Valid PR registry: ${repository}, ${document.units.length} approved units; runtime acceptance is separate.`);

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (pkg.dependencies['@accountability/factual-investigation'] !==
    'git+https://github.com/neophilism/Factual-investigation-engine.git#48e02a6568f09e1d091eb24d6f161a6bcb7a8de5')
  throw new Error('Accepted Factual pin required');
if (pkg.dependencies['@accountability/knowledge-verification'] !==
    'git+https://github.com/neophilism/Knowledge-and-verification-engine.git#31211e545f73dd99318d2960be3212a511b7cffd')
  throw new Error('Accepted Knowledge runtime pin required');
console.log('Accepted Factual snapshot and Knowledge runtime SDKs pinned');

const lock=JSON.parse(await readFile(new URL('../package-lock.json',import.meta.url),'utf8'));
const knowledge=lock.packages['node_modules/@accountability/knowledge-verification'];
if (knowledge.dependencies['@accountability/evidence'] !== 'git+https://github.com/neophilism/Evidence-Storage-and-Provenance-Engine.git#d240403c39934ab781178efea8cf4922c94d88a4' ||
    knowledge.dependencies['@accountability/evidence-sql'] !== 'git+https://github.com/neophilism/Evidence-Storage-and-Provenance-Engine.git#dce7105a70b42d77afe4cd48d34723331447037c')
  throw new Error('Current Knowledge source SDK and separate stable persistence lock metadata required');

const correspondencePin='git+https://github.com/neophilism/Correspondence-and-Outreach-Engine.git#e6555140adefdab37c9140ef8362dcfb0e10fcf5';
if(pkg.dependencies['@accountability/correspondence']!==correspondencePin ||
   !lock.packages['node_modules/@accountability/correspondence'].resolved.endsWith('#e6555140adefdab37c9140ef8362dcfb0e10fcf5'))
  throw new Error('Accepted hardened Correspondence operator SDK pin/lock required');
console.log('Accepted hardened Correspondence operator SDK pinned');
