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
    'git+https://github.com/neophilism/Knowledge-and-verification-engine.git#eda0e7ba7ed3337902b8c04d58ae37bd71b2421e')
  throw new Error('Accepted Knowledge runtime pin required');
console.log('Accepted Factual snapshot and Knowledge runtime SDKs pinned');
