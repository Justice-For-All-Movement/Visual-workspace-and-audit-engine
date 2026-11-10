# Visual Workspace and Audit Engine

Reusable country-neutral engine. Initial capabilities and limits are documented in [architecture](docs/ARCHITECTURE.md); the canonical work plan is [registry/prs.json](registry/prs.json).

```sh
npm ci
npm run check
```

All research and jurisdiction configuration belong in downstream deployments. Implementation, local tests, CI, merge and live acceptance are separate.

The opt-in `./consent-review` module adds [private participant consent inspectors](docs/CONSENT_REVIEW.md), including original capture receipts and current withdrawal without inferring use authorization. Generate its fictional example with `npm run example:consents`.

## Service layer

`src/engine/` is the E14 service: it aggregates the other engines through a port registry (always with the caller's
own context) and stores only its own data (saved views, annotations, control invocations, audit) in the PostgreSQL schema
`e14_workspace`. `web/` is a dependency-free browser component library that renders the service's JSON. The full contract
for both is in [docs/ENGINE_API.md](docs/ENGINE_API.md).

```sh
# run standalone (reads other engines over HTTP with the caller's token)
DATABASE_URL=postgresql://… IDENTITY_PUBLIC_KEYS='{"kid":"-----BEGIN PUBLIC KEY-----…"}' \
WORKSPACE_ENGINE_URLS='{"E05":"http://127.0.0.1:8105"}' PORT=8114 npm run serve
# then open http://127.0.0.1:8114/web/demo.html (fictional recorded data)

# test
TEST_DATABASE_URL=postgresql://pam:pam@127.0.0.1:5432/postgres npm run check   # typecheck, unit + PostgreSQL tests, build
npm run test:browser                                                            # Playwright + axe-core (needs Playwright/Chromium)
```

```ts
import { createEngine, migrate, routes } from '@accountability/visual-workspace/engine';
await migrate(sql);
const workspace = createEngine({ sql, ports: { engines: { E05: evidence, E07: knowledge /* … */ }, controls: { E00: taskControls } } });
const view = await workspace.inspectLinked(ctx, 'E07:claim:abc', { depth: 2 }); // graph + table + text outline
```
