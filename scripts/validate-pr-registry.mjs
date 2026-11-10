import {readFile} from 'node:fs/promises';
import {parsePrRegistry} from '../registry/pr-contract.mjs';
const body = await readFile(new URL('../registry/prs.json', import.meta.url), 'utf8');
// The registry is a historical record written under the original organization. The repository was transferred
// unchanged, so the current checkout must be the same repository name under the recorded or the current organization.
const recorded = JSON.parse(body).repository;
const current = process.env.GITHUB_REPOSITORY || recorded;
const ORGANIZATIONS = ['neophilism', 'Justice-For-All-Movement'];
const [currentOwner, currentName] = current.split('/');
if (String(currentName).toLowerCase() !== String(recorded).split('/')[1].toLowerCase() ||
    (current !== recorded && !ORGANIZATIONS.includes(currentOwner)))
  throw new Error('Registry belongs to a different repository: ' + recorded);
const repository = recorded;
// Dependency pins keep their accepted commit; only the organization prefix may be the current one.
const samePin = (actual, accepted) => typeof actual === 'string' &&
  ORGANIZATIONS.some(org => actual === accepted.replace('github.com/neophilism/', 'github.com/' + org + '/'));
const {document} = parsePrRegistry(body, repository);
const retired = JSON.parse(await readFile(new URL('../registry/roadmap.json', import.meta.url), 'utf8'));
if (retired.repository !== repository || retired.deprecated !== true || retired.redirectTo !== 'registry/prs.json' ||
    Object.hasOwn(retired, 'milestones') || Object.hasOwn(retired, 'units') || Object.hasOwn(retired, 'plannedPrCount'))
  throw new Error('Only registry/prs.json may contain the active PR plan');
console.log(`Valid PR registry: ${repository}, ${document.units.length} approved units; runtime acceptance is separate.`);

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (!samePin(pkg.dependencies['@accountability/factual-investigation'],
    'git+https://github.com/neophilism/Factual-investigation-engine.git#48e02a6568f09e1d091eb24d6f161a6bcb7a8de5'))
  throw new Error('Accepted Factual pin required');
if (!samePin(pkg.dependencies['@accountability/knowledge-verification'],
    'git+https://github.com/neophilism/Knowledge-and-verification-engine.git#31211e545f73dd99318d2960be3212a511b7cffd'))
  throw new Error('Accepted Knowledge runtime pin required');
console.log('Accepted Factual snapshot and Knowledge runtime SDKs pinned');

const lock=JSON.parse(await readFile(new URL('../package-lock.json',import.meta.url),'utf8'));
const knowledge=lock.packages['node_modules/@accountability/knowledge-verification'];
if (!samePin(knowledge.dependencies['@accountability/evidence'], 'git+https://github.com/neophilism/Evidence-Storage-and-Provenance-Engine.git#d240403c39934ab781178efea8cf4922c94d88a4') ||
    !samePin(knowledge.dependencies['@accountability/evidence-sql'], 'git+https://github.com/neophilism/Evidence-Storage-and-Provenance-Engine.git#dce7105a70b42d77afe4cd48d34723331447037c'))
  throw new Error('Current Knowledge source SDK and separate stable persistence lock metadata required');

const correspondencePin='git+https://github.com/neophilism/Correspondence-and-Outreach-Engine.git#e6555140adefdab37c9140ef8362dcfb0e10fcf5';
if(!samePin(pkg.dependencies['@accountability/correspondence'],correspondencePin) ||
   !lock.packages['node_modules/@accountability/correspondence'].resolved.endsWith('#e6555140adefdab37c9140ef8362dcfb0e10fcf5'))
  throw new Error('Accepted hardened Correspondence operator SDK pin/lock required');
console.log('Accepted hardened Correspondence operator SDK pinned');

if (!knowledge.resolved.endsWith('#31211e545f73dd99318d2960be3212a511b7cffd'))
  throw new Error('Accepted selected-verification Knowledge SDK lock pin required');
