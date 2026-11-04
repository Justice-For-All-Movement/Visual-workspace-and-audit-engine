import { mkdir, writeFile } from 'node:fs/promises';
import { renderWorkspace } from '../dist/index.js';
const context = {
  tenantId: 'fiction', projectId: 'timeline-demo',
  actor: { id: 'fixture-reviewer', kind: 'human', roles: ['viewer'] },
  purpose: 'private-review', requestId: 'example', now: '2026-01-01T00:00:00Z'
};
const snapshot = {
  tenantId: context.tenantId, projectId: context.projectId,
  schemaVersion: 1, visibility: 'private',
  title: 'Fictional private timeline review', capturedAt: context.now,
  nodes: [], agents: [],
  events: [{
    id: 'fictional-projected-event', at: context.now,
    actorId: 'fictional-reviewer', action: 'Fictional observation',
    resource: { tenantId: context.tenantId, projectId: context.projectId,
      kind: 'aggregate', id: 'fictional-ledger', revision: 3 },
    summary: 'Illustrative host projection only; no independent audit or identity proof.'
  }]
};
await mkdir(new URL('../docs/examples/', import.meta.url), { recursive: true });
await writeFile(new URL('../docs/examples/private-timeline.html', import.meta.url), renderWorkspace(context, snapshot));
