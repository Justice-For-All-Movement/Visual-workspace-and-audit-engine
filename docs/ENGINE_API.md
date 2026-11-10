# E14 Visual Workspace and Audit — engine API

Two deliverables in this repository:

- **Service layer** (`src/engine/`): aggregates the other engines through a port registry and persists only E14's own
  data. Entry `@accountability/visual-workspace/engine` (`src/engine/index.ts`), server `…/serve` (`src/engine/serve.ts`).
- **Browser component library** (`web/`): plain ES modules and one stylesheet that render the service-layer JSON.

Kit: `src/service-kit.ts` version **1.0.1**, sha256 `95475a907267ba1fdd54b557aabe5645c37add9788a5b2d0854d9accfd5d8ea5`
(byte-identical copy from the Identity engine; `src/contracts.ts` is the Identity version too).

Status words used below: **tested** = covered by automated tests in this repository on real PostgreSQL / real Chromium;
**not verified** = implemented but never exercised against the real thing.

---

## 1. Principles

- E14 owns no domain facts. Every read goes through `deps.ports.engines[<id>]` using the **caller's**
  `ServiceContext`; E14 never builds an elevated or service context. A missing capability, a hidden compartment or a
  foreign tenant simply yields nothing from the owning engine.
- A forbidden object and a missing object are indistinguishable: `not_found` for a direct read, state
  `forbidden_or_missing` (reference only, no title, no counts) when it appears as a neighbour.
- An unreachable engine is always shown: state `unavailable`, `unavailableEngines`, per-engine `status`. Nothing is dropped
  silently and internal error text from a port is never passed on (only `timeout`, `error`, `not_connected` or the
  engine's own DomainError code).
- Nothing is invented: no computed progress, no summaries, no metrics beyond what an engine's `health()` reports.
- E14 never changes another engine's data. Controls call the host-supplied `ControlPort`, which maps to real engine methods.

## 2. Entry points

```ts
import { SCHEMA, manifest, migrations, migrate, createEngine, routes } from '@accountability/visual-workspace/engine';
export const SCHEMA = 'e14_workspace';
export function migrate(sql: Sql): Promise<string[]>;
export function createEngine(deps: EngineDeps): WorkspaceEngine;      // implements StandardEngine
export function routes(engine: WorkspaceEngine): Route[];             // standardRoutes + own /v1 routes, error-mapped

type EngineDeps = {
  sql: Sql;
  ports?: {
    engines?: Record<string, EnginePort>;      // keyed 'E00' … 'E13' (never 'E14')
    controls?: Record<string, ControlPort>;    // keyed by owning engine id; '*' = offered for every object (source 'host')
  };
  config?: { engineTimeoutMs?: number /*5000*/; controlTimeoutMs?: number /*30000*/; defaultDepth?: number /*2*/; maxDepth?: number /*6*/;
             maxNodes?: number /*200*/; auditScanLimit?: number /*5000*/; concurrency?: number /*8*/ };
};
type EnginePort = Pick<StandardEngine, 'manifest' | 'inspect' | 'search' | 'audit' | 'health'>;   // pass the real engines
type ControlSpec = { id: string; label: string; capability: string; dangerous: boolean; input: Json; description?: string };
interface ControlPort {
  controlsFor(ctx: ServiceContext, ref: string): Promise<ControlSpec[]>;
  invoke(ctx: ServiceContext, ref: string, controlId: string, input: Json): Promise<Json>;
}
```

With no ports the engine still works (own views, annotations, audit). An engine id referenced by an object but absent
from the registry is reported as `unavailable` with reason `not_connected`.

**DomainError across engines**: E14 recognises DomainErrors structurally (`name === 'DomainError'` and a string `code`),
so errors thrown by another engine's copy of the class are classified correctly (tested).

### Capabilities

| Capability | Needed for |
|---|---|
| `workspace:read` | every read method, `inspect`, `search`, `audit` |
| `workspace:write` | saved views, annotations, acknowledging flags |
| `workspace:control` | `invokeControl` (in addition to the control's own `capability`) |
| `workspace:export` | `exportAudit` and the `workspace.export_audit` control (sensitive: never granted by `workspace:*`) |
| `workspace:events` | `events`, `applyUpstreamChange` (sensitive) |

Reading another engine's objects additionally needs whatever that engine requires (for example `knowledge:read`), because
that engine is called with the caller's context.

## 3. Service methods (`WorkspaceEngine`)

All take `ctx: ServiceContext` first and fail closed (`forbidden` / `unauthenticated`). Input errors are `invalid_input` or
`invalid_reference`.

### 3.1 Cross-engine read models

```ts
inspectLinked(ctx, ref, options?: { depth?: number; direction?: 'both' | 'upstream' | 'downstream'; maxNodes?: number }): Promise<LinkedView>
inspectOne(ctx, ref): Promise<ObjectView & { annotations: Annotation[] }>
searchAll(ctx, query: { q: string; engines?: string[]; limit?: number }): Promise<SearchAllResult>
auditTimeline(ctx, query?: AuditQuery): Promise<AuditTimeline>
exportAudit(ctx, query?: AuditQuery & { format?: 'csv' | 'json'; includeDetail?: boolean }): Promise<AuditExport>
overview(ctx): Promise<Overview>
listEngines(ctx): Promise<{ engine: string; name: string; version: string; emits: string[]; controls: boolean }[]>
```

**`inspectLinked`** resolves `ref` through the owning engine's `inspect`, then follows `sources` upstream and `dependents`
downstream, breadth-first. From the root it follows sources transitively and dependents transitively (it does not mix
directions, so the result is the object's lineage, not everything connected to it).

```ts
type DisplayState = 'ok' | 'stale' | 'blocked' | 'failed' | 'unavailable' | 'forbidden_or_missing';
type GraphNode = { ref: string; engine: string; kind: string; title: string; state: DisplayState; engineState: string;
                   stale: boolean; blocked: boolean; staleReasons: string[];
                   versionCount: number; permissionCount: number; decisionCount: number; depth: number };
type GraphEdge = { from: string; to: string; relation: 'source' | 'dependent' };
type LinkedView = {
  root: string; depth: number; direction: 'both' | 'upstream' | 'downstream';
  nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean; unavailableEngines: string[];
  table: TableModel;        // { caption, columns: [{ key, label }], rows: Record<string, string|number|boolean>[] }
  nodeTable: TableModel;    // one row per node
  outline: { lines: { level: number; relation: 'root'|'source'|'dependent'|'heading'; ref: string|null; parent: string|null; repeated: boolean; text: string }[]; text: string };
  generatedAt: string;      // ctx.now — show it; the view is a snapshot
};
```

- Node `ref` is the canonical reference returned by the owning engine (usually with a revision); references that name the
  same object collapse into one node.
- `state`: `blocked` if the engine says blocked; else `failed` if the engine state is `failed|dead|error|errored`; else
  `stale` if stale; else `ok`. `engineState` is the engine's own state word, unchanged. `unavailable` = the engine could
  not be asked (down, timeout, not connected). `forbidden_or_missing` = the engine answered null or denied.
- Edge semantics: `{ from, to, relation: 'source' }` means *`to` is a source of `from`*; `'dependent'` means *`to` depends
  on `from`*. A relationship declared from both ends appears once. `canonicalEdge(edge)` in `web/model.js` gives
  `{ upstream, downstream }`.
- `table`: first row is the selected object (`relation: 'root'`), then one row per edge with keys `relation`,
  `relationLabel`, `from`, `fromTitle`, `to`, `toTitle`, `toEngine`, `toKind`, `toState`, `toStateLabel`, `toReasons`. The set
  of `to` values equals the node set; the non-root rows equal the edge set. `outline.text` is the indented plain-text
  form; a node already expanded is listed again with "(listed above)" so cycles terminate.
- Limits: `depth` 0…`maxDepth` (default 2, values above the cap are capped), `maxNodes` up to the configured cap, at most
  500 sources/dependents per node. Whenever anything was cut, `truncated` is `true`.
- Root: forbidden/missing → `not_found`; engine unavailable → a single `unavailable` node (not an error).
- Table, node table and outline are produced by the same functions (`web/model.js`) the browser components use.

**`inspectOne`** returns the kit `Inspection` normalised: `ref, engine, engineName, kind, title, state, engineState, stale,
blocked, staleReasons, badges: [{ state, label, description }], sources / dependents: [{ ref, engine, kind, id, revision }],
versions, permissions, decisions, history, data, generatedAt`, plus `annotations` (E14's own notes on that object, any
revision). Errors: `not_found` (missing or forbidden), `unavailable` (engine unreachable; HTTP 503).

**`searchAll`** fans out to the selected (default: all registered, plus E14) engines:
`{ q, total, generatedAt, groups: [{ engine, name, status: 'ok' | 'unavailable' | 'forbidden', reason?, hits: SearchHit[] }] }`.
`limit` is per engine (default 20, max 100). Hits whose reference does not belong to the answering engine are discarded.

**`auditTimeline`**

```ts
type AuditQuery = { subject?: string; engines?: string[]; after?: string /* ISO time, exclusive */; limit?: number /* 200, max 1000 */;
                    order?: 'asc' | 'desc' /* asc */; cursors?: Record<string, string>; verifyChains?: boolean /* true */ };
type AuditTimeline = {
  records: { engine, id, tenantSeq, projectId, at, actorId, actorKind, action, subject, requestId, purpose, detail, hash }[];
  engines: { engine, name, status: 'ok' | 'unavailable' | 'forbidden', reason?, count, chain, exhausted }[];
  order: 'asc' | 'desc'; truncated: boolean; cursors: Record<string, string>; generatedAt: string;
};
```

- Ascending: a k-way merge by time (`at`, then engine, then record id) that never reorders one engine's own feed. To page,
  pass the returned `cursors` back; every record is returned exactly once (tested, including an out-of-sequence timestamp).
- Descending: the newest `limit` records; no cursors. Each engine is read up to `auditScanLimit` records; beyond that
  `truncated` is true and the newest records of a longer feed are not reached — use `after` to narrow.
- `chain` per engine: `verified` / `broken` — the records readable by the caller start at tenant sequence 1 without gaps
  and were checked with the kit's `verifyAuditChain`; `partial` — gaps (records of other projects) or more than
  `auditScanLimit` records, so the chain cannot be verified from here; `empty`; `not_checked` (`verifyChains: false`, or
  the engine was not readable). `verified` therefore means "what you can read is an intact chain from its start".
- Records whose tenant/project differ from the caller's are dropped even if a port returns them.

**`exportAudit`** (needs `workspace:export`) returns `{ id, format, mediaType, filename, content, sha256, recordCount,
truncated, engines }`. CSV columns: `at, engine, id, actorId, actorKind, action, subject, requestId, purpose`; every cell is
quoted and spreadsheet formula prefixes are neutralised. JSON is canonical JSON with the records and per-engine status.
The free-form `detail` payload is omitted unless `includeDetail: true`. Each export is recorded in E14's audit log
(`audit.exported` with format, count, sha256) and emits `audit.exported`. Limit: `auditScanLimit` records per engine.

**`overview`**: `{ generatedAt, engines: [{ engine, name, version, status: 'ok' | 'degraded' | 'unavailable', reason?, counts,
detail }] }`. `counts` are only the numeric values found in the engine's own `health().detail` (top level, `counts`, `jobs`,
`queue`). Note: `health()` takes no context, so what it reports is each engine's decision.

### 3.2 Saved views (own data)

```ts
createView(ctx, input: { name; pins?: ViewPin[]; filters?: Json; layout?: Json; notes?: string; sharedRoles?: string[]; editorRoles?: string[]; idempotencyKey? }): Promise<SavedView>
updateView(ctx, id, patch: Partial<ViewInput> & { expectedRevision: number; summary?: string; idempotencyKey? }): Promise<SavedView>
archiveView(ctx, id, options: { expectedRevision: number; archived?: boolean }): Promise<SavedView>
getView(ctx, id, options?: { revision?: number }): Promise<SavedView>
listViews(ctx, options?: { includeArchived?: boolean; limit?: number }): Promise<SavedView[]>
listViewRevisions(ctx, id): Promise<{ revision, at, actorId, summary, name, archived }[]>
resolveView(ctx, id): Promise<Board>
acknowledgeViewFlags(ctx, id, options?: { refs?: string[]; note?: string }): Promise<SavedView>

type ViewPin = { ref: string; label?: string; note?: string; x?: number; y?: number };
type SavedView = { id; ref /* E14:view:<id>@<rev> */; revision; currentRevision; name; ownerId; sharedRoles; editorRoles; archived;
                   pins; filters; layout; notes; stale; blocked; flags: ViewFlag[]; canEdit; createdAt; updatedAt };
type ViewFlag = { id; ref; effect: 'stale' | 'blocked'; reason; changeKind; causeEventId; causeRef; flaggedAt; acknowledgedAt; acknowledgedBy };
type Board = { view: SavedView; pins: (ViewPin & { engine, kind, title, state, engineState, stale, blocked, staleReasons, flags })[]; unavailableEngines; generatedAt };
```

- Visibility: the owner, holders of a role in `editorRoles` (read + edit) and holders of a role in `sharedRoles` (read).
  Anyone else gets `not_found`. Only the owner changes sharing. Pinned references and notes are visible to everyone the
  view is shared with — the owner chooses what to pin; the live state of each pin on a board is still fetched with the
  viewer's own context, so a pin the viewer may not see shows `forbidden_or_missing`.
- Every change is a new revision (`revision_conflict` on a wrong `expectedRevision`); earlier revisions stay readable.
- Limits: 500 pins, name 200 chars, notes 20 000 chars, filters 16 KiB, layout 64 KiB, 50 roles per list.
- `stale` / `blocked` are derived from unacknowledged flags on references pinned in the current revision.

### 3.3 Annotations (own data)

```ts
annotate(ctx, input: { ref; kind?: 'note' | 'review' | 'correction_request' | 'flag'; body; idempotencyKey? }): Promise<Annotation>
resolveAnnotation(ctx, id, input?: { resolution?: string }): Promise<Annotation>
listAnnotations(ctx, options?: { ref?; status?: 'open' | 'resolved'; limit? }): Promise<{ annotations: Annotation[]; unavailableEngines: string[] }>
```

An annotation is only as visible as its subject: writing, listing and resolving require that the caller can inspect the
object (`not_found` otherwise; `unavailable` when its engine cannot confirm). The audit trail records that a note exists,
never its text. A correction request is a note for the owning team; it does not change the owning engine.

### 3.4 Controls

```ts
listControls(ctx, ref): Promise<{ ref; controls: (ControlSpec & { source: string; allowed: boolean; deniedReason?: string })[]; unavailable: boolean; generatedAt }>
invokeControl(ctx, ref, controlId, input?: Json, options?: { confirm?: boolean; idempotencyKey?: string }): Promise<ControlInvocation>
listControlInvocations(ctx, options?: { ref?; limit? }): Promise<ControlInvocation[]>
type ControlInvocation = { id; ref /* E14:control_invocation:<id> */; subject; controlId; source; capability; dangerous;
                           outcome: 'attempted' | 'succeeded' | 'failed' | 'denied' | 'uncertain'; result: Json;
                           error: { code; message } | null; actorId; requestId; startedAt; finishedAt };
```

- Controls come from `ports.controls[<owning engine>]` and `ports.controls['*']`, followed by three built-ins on every
  visible object: `workspace.review_note`, `workspace.request_correction` (both create annotations; capability
  `workspace:write`) and `workspace.export_audit` (capability `workspace:export`). Specs with a malformed id/capability or
  an id starting with `workspace.` are ignored. `input` is a JSON-Schema subset (`type: 'object'`, `properties` with
  `type` string/number/integer/boolean, `enum`, `maxLength`, `title`; `required`; `additionalProperties: false`) that is
  both validated by the service and used by `ControlBar` to build the form.
- `invokeControl` order: `workspace:control` → object visible → control exists → caller holds the control's
  `capability` (otherwise outcome `denied` is recorded and `forbidden` thrown; the port is not called) → dangerous
  controls need `options.confirm === true` (`confirmation_required`) → input validated → `attempted` recorded → port
  called with the caller's `ctx` → outcome recorded.
- Outcomes: an engine DomainError → `failed`, rethrown as `ControlError` with the engine's own `code` and `message` and
  `invocationId`. A timeout or a non-domain failure → `uncertain` (`control_uncertain`); it is never reported as failed
  or succeeded and never retried automatically. With `idempotencyKey`, a replay returns the recorded invocation without
  calling the port; an attempt whose outcome was never recorded answers `idempotency_conflict`.
- Audit: `control.attempted`, then `control.succeeded | failed | uncertain`, or `control.denied`, on the object's
  reference, with the control id, capability and an input digest — never the input or the result.
- The host supplies the mapping to real engine methods (pause/resume/cancel/retry/reassign a task, approve/reject, mark
  for correction, export …). **No real-engine control ports are shipped in this repository**; they are tested here against
  an in-test task engine.

### 3.5 Standard surface

`inspect` (kinds `view`, `annotation`, `control_invocation`), `search` (view names/notes the caller may read, annotation
text on visible subjects), `audit`, `events` (`workspace:events`), `applyUpstreamChange`, `health`.

**`applyUpstreamChange(ctx, { eventId, kind, refs, reason })`** (`workspace:events`): for every non-archived saved view in
the caller's tenant/project whose current revision pins one of `refs` (`urefMatches`), records a flag per pinned
reference — `blocked` for `permission_withdrawn` and `source_removed`, `stale` for every other kind — appends
`view.stale` / `view.blocked` to the audit log, emits the event of the same name with `{ reason, cause, refs }` and returns
`{ affected: ['E14:view:<id>@<rev>'] }`. Idempotent by `eventId` (the stored result is returned). Nothing is deleted or
rewritten; a flag stays until an editor acknowledges it or the reference is unpinned in a later revision.

### Events emitted (subject)

`view.created`, `view.updated`, `view.archived`, `view.stale`, `view.blocked`, `view.flags_acknowledged` (`E14:view:<id>@<rev>`) ·
`annotation.created`, `annotation.resolved` (`E14:annotation:<id>`) · `control.succeeded`, `control.failed`, `control.uncertain`
(the object the control acted on) · `audit.exported` (the subject filter, or `E14:audit_export:<id>`).
The catalog's `projection.lagged` and `alert.raised` are **not implemented**.

## 4. HTTP API

`routes(engine)` = kit standard routes (`/v1/manifest`, `/v1/inspect`, `/v1/search`, `/v1/audit`, `/v1/events`,
`/v1/upstream-changes`, `/healthz`) plus the routes below. Bearer token on everything except `/healthz` and `/v1/manifest`.

| Method and path | Service method | Notes |
|---|---|---|
| `GET /v1/linked?ref=&depth=&direction=&maxNodes=&format=json\|table\|text` | `inspectLinked` | `format=text` → `text/plain` outline; `table` → the relation table |
| `GET /v1/objects?ref=` | `inspectOne` | 404 for missing/forbidden, 503 `unavailable` |
| `GET /v1/search-all?q=&engines=E05,E07&limit=` | `searchAll` | |
| `GET /v1/audit-timeline?subject=&engines=&after=&limit=&order=&cursors=E05:12,E07:3&verify=0` | `auditTimeline` | |
| `GET /v1/audit/resources/:ref` | `auditTimeline({ subject })` | `:ref` URL-encoded |
| `GET /v1/audit-timeline/export?format=csv\|json&…&detail=1` | `exportAudit` | file download; headers `x-export-id`, `x-export-sha256`, `x-export-records`, `x-export-truncated` |
| `POST /v1/audit-exports` | `exportAudit` | JSON envelope |
| `GET /v1/overview` | `overview` | |
| `GET /v1/views/:view` | `overview \| linked \| object \| search \| audit` | same handlers as above (catalog path) |
| `GET /v1/streams` | `listEngines` | connected sources only; **no push stream** — clients poll |
| `POST /v1/saved-views` (201) · `GET /v1/saved-views?archived=1` | `createView` · `listViews` | |
| `GET /v1/saved-views/:id?revision=` · `PATCH /v1/saved-views/:id` | `getView` · `updateView` | |
| `GET /v1/saved-views/:id/revisions` · `GET …/board` | `listViewRevisions` · `resolveView` | |
| `POST /v1/saved-views/:id/archive` · `POST …/acknowledge` | `archiveView` · `acknowledgeViewFlags` | |
| `POST /v1/annotations` (201) · `GET /v1/annotations?ref=&status=` · `POST /v1/annotations/:id/resolve` | `annotate` · `listAnnotations` · `resolveAnnotation` | |
| `GET /v1/controls?ref=` | `listControls` | |
| `POST /v1/controls/invoke` `{ ref, controlId, input?, confirm?, idempotencyKey? }` | `invokeControl` | |
| `GET /v1/control-invocations?ref=&limit=` | `listControlInvocations` | |

Errors are `{ error: { code, message, requestId, invocationId? } }`. Because the kit masks 5xx and unmapped codes, the
routes map them: `unavailable` → **503**, `confirmation_required` → **409**, `control_uncertain` → **504**, a control
refused by its engine with a code the kit does not know → **409** with the engine's code and message; kit-mapped codes
keep their status (`forbidden` 403, `invalid_state` 409, `revision_conflict` 409, `invalid_*` 400, …); `not_found` is
always the generic 404 body.

## 5. Standalone server

`npm run serve` (`node src/engine/serve.ts`). There are no background jobs, so no worker loop.

| Variable | Meaning |
|---|---|
| `DATABASE_URL` (required), `DATABASE_POOL_MAX` | PostgreSQL |
| `PORT` (8080), `HOST` (127.0.0.1) | listener |
| `IDENTITY_PUBLIC_KEYS` (JSON map kid→PEM) or `IDENTITY_JWKS_FILE`; `IDENTITY_ISSUER` (optional) | token verification |
| `WORKSPACE_ENGINE_URLS` | JSON map engine id → base URL, e.g. `{"E05":"http://127.0.0.1:8105"}` |
| `WORKSPACE_ENGINE_TIMEOUT_MS`, `WORKSPACE_CONTROL_TIMEOUT_MS`, `WORKSPACE_MAX_NODES`, `WORKSPACE_MAX_DEPTH`, `WORKSPACE_AUDIT_SCAN_LIMIT` | limits |
| `WORKSPACE_SERVE_WEB=0` | do not serve `web/` |

Each configured engine is read over its standard HTTP surface (`/v1/inspect`, `/v1/search`, `/v1/audit`, `/healthz`,
`/v1/manifest`) with the **caller's own bearer token** forwarded; there is no service credential (tested against two
in-test engines served over HTTP). The standalone server has no control ports, so only the built-in workspace controls
are offered. `OBJECT_STORE*` is not used: E14 stores no objects. Token revocation is not checked by the standalone server
(signature, expiry and issuer only); a host that needs it supplies its own verifier.

`serve.ts` also exports `httpEnginePort(id, baseUrl, tokenOf)`, `webRoutes(prefix = '/web')` (public static routes for the
component library with a restrictive Content-Security-Policy) and `WEB_DIR`.

## 6. Browser component library (`web/`)

Plain ES modules, one stylesheet, no runtime dependencies, no build step. Serve the directory as-is and import
`…/web/index.js`; link `…/web/workspace.css`. Types: `web/index.d.ts`, `web/model.d.ts`. Package export:
`@accountability/visual-workspace/web/*`.

**Contract of every component**: `Component(container: HTMLElement, props) => { update(partialProps), destroy(), props }`.
`update` merges the given props into the current ones and re-renders; `destroy` removes everything it rendered.
Components never fetch: the host passes data and callbacks. All strings are rendered as text (never as HTML). The
components work under `style-src 'self'; script-src 'self'`.

Shared conventions: `onNavigate(ref: string)` is called for every universal reference a user activates;
`state?: 'ready' | 'loading' | 'error' | 'denied' | 'disconnected' | 'empty'` with `error?: { code?, message?, requestId?, engines? }`
and `onRetry?()` selects a whole-panel state instead of data (InspectorPanel, SearchResults).

| Component | Props (data from) | Callbacks |
|---|---|---|
| `GraphView` | `graph` (a `LinkedView`: `root, nodes, edges, truncated, unavailableEngines`), `table?`, `outline?` (pass the service's to avoid recomputing), `selected?` (node ref), `view?: 'graph' \| 'table' \| 'text'`, `label?` | `onSelect(ref)` node activated; `onNavigate(ref)` link in table/text view (falls back to `onSelect`); `onViewChange(view)` — when given, `view` is host-controlled |
| `RelationTable` | `graph` or `table` | `onNavigate` |
| `TextOutline` | `graph` or `outline` | `onNavigate` |
| `InspectorPanel` | `object` (`inspectOne` result or `null`), `state?`, `error?`, `tab?`, `headingLevel?` (default 3) | `onNavigate`, `onTabChange(tab)` (then `tab` is host-controlled), `onRetry` |
| `StateBadge` | `state`, `label?`, `reasons?`, `at?`, `showReasons?` | — |
| `AuditTimeline` | `records`, `engines?`, `truncated?` (from `auditTimeline`), `filter?: { engine?, actor?, action?, text? }`, `height?` (px) | `onFilterChange(filter)` (then `filter` is host-controlled), `onNavigate`, `onExport(format, filter)`, `onLoadMore()` |
| `TaskBoard` | `items: [{ ref, title, state, engineState, staleReasons? }]` (graph nodes or board pins), `edges?`, `controlsByRef?: Record<ref, ListedControl[]>`, `selected?`, `headingLevel?` | `onSelect(ref)`, `onInvoke` (as ControlBar) |
| `ControlBar` | `ref`, `controls` (from `listControls`), `label?`, `compact?` | `onInvoke(ref, controlId, input, { confirm }) => Promise` |
| `SearchResults` | `result` (`searchAll` result or `null`), `state?`, `error?`, `headingLevel?` | `onNavigate`, `onRetry` |
| `DataTable` | `caption`, `columns: [{ key, label, sortable?, numeric?, render?(row) }]`, `rows`, `rowHeader?` (key of the row-header column; default first), `sort?`, `emptyText?`, `captionHidden?` | `onSort({ key, dir })` (then `sort` is host-controlled) |
| `EmptyState` | `title?`, `message?`, `action?: { label, onAction }` | |
| `ErrorState` | `message`, `title?`, `code?`, `requestId?` | `onRetry` |
| `LoadingState` | `label?` | static text; no spinner or progress |
| `PermissionDeniedState` | `message?`, `capability?` | |
| `DisconnectedState` | `engines?`, `reason?`, `since?` | `onRetry` |

Also exported: `badge(state, options)`, `stateIcon(state)`, `refLink(ref, onNavigate)`, `jsonView(value, onNavigate)`,
`INSPECTOR_TABS`, `VERSION`, and `model` (`web/model.js`: `deriveState`, `relationTable`, `nodeTable`, `textOutline`,
`layoutLayers`, `moveFocus`, `canonicalEdge`, `edgeKey`, `filterAudit`, `auditCsv`, `groupTasks`, `STATE_LABELS`, …).

Behaviour the host can rely on:

- **GraphView** — layered layout computed in the component (sources left of the selected object, dependents right).
  Each node is a focusable `role="button"` with a full text name (title, engine, kind, state with reasons, reference,
  number of sources and dependents); one tab stop (roving tabindex). Keys: Left/Right follow edges to sources/dependents,
  Up/Down move within a column, Home returns to the root, Enter/Space call `onSelect`, `+`/`-` zoom, `0` fit. Pointer drag
  pans, Ctrl+wheel zooms; a focused node is panned into view. State is a text label plus a distinct shape per state.
  Truncation and unavailable engines are shown as text notices. The Graph / Table / Text outline switch is built in.
- **InspectorPanel** — tabs Summary · Sources · Dependents · Versions · Permissions · Decisions · History · Raw as an ARIA
  `tablist` (arrow keys, Home, End, automatic activation; one `tabpanel`). Every universal reference anywhere in the
  object (including inside permissions, decisions and history details) is a control calling `onNavigate`.
- **ControlBar** — a control with `allowed: false` is shown, marked `aria-disabled`, with its `deniedReason` in text.
  A dangerous control or one with inputs opens a modal dialog (focus trapped, Escape closes, focus returns to the
  button, safe choice focused first for dangerous actions without inputs); nothing is sent before confirmation.
  `onInvoke` must return a Promise: resolve with the `ControlInvocation` (its `outcome` is shown; anything but
  `succeeded` is presented as an error) or reject with `{ code, message }` (shown verbatim as an alert). While waiting
  it shows "Sent; waiting for the engine to answer." — no progress is implied.
- **AuditTimeline** — only the rows in the scrolled window are in the DOM; `aria-rowcount` / `aria-rowindex` give true
  positions. Filters by engine, actor, action and text apply to the records passed in. Per-engine status and chain
  result are listed in text ("HASH CHAIN BROKEN" for `broken`).
- **TaskBoard** — columns by the engine's own state word (`queued`, `running`, `review`, `paused`, `blocked`, `failed`,
  `done`, `cancelled`, `other`; `blocked`/`failed` display states take precedence). Each card states what it waits on and
  how many of those are not done, from the `edges` passed in.
- Theme: CSS custom properties on `:root` (`--ws-*`), dark values under `prefers-color-scheme: dark`. No animation or
  transition anywhere. Visible focus rings on every interactive element.

Minimal wiring:

```js
import { GraphView, InspectorPanel, ControlBar } from '/engines/workspace/web/index.js';
const api = (path, init) => fetch(`/engines/workspace${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } })
  .then(async (r) => (r.ok ? r.json() : Promise.reject((await r.json()).error)));
const inspector = InspectorPanel(inspectorEl, { object: null, onNavigate: show });
const bar = ControlBar(controlsEl, { ref: '', controls: [], onInvoke: (ref, controlId, input, { confirm }) =>
  api('/v1/controls/invoke', { method: 'POST', body: JSON.stringify({ ref, controlId, input, confirm }) }) });
let graph;
async function show(ref) {
  inspector.update({ state: 'loading' });
  const [linked, object, controls] = await Promise.all([api(`/v1/linked?ref=${encodeURIComponent(ref)}`), api(`/v1/objects?ref=${encodeURIComponent(ref)}`), api(`/v1/controls?ref=${encodeURIComponent(ref)}`)]);
  if (graph) graph.destroy();
  graph = GraphView(graphEl, { graph: linked, table: linked.table, outline: linked.outline, selected: linked.root, onSelect: show, onNavigate: show });
  inspector.update({ object, state: 'ready' });
  bar.update({ ref, controls: controls.controls });
}
```

`web/demo.html` is a demonstration page driven by `web/fixtures.js`: fictional data captured from the real service layer
running against the in-test engines (`node scripts/build-web-fixtures.ts`). Its actions replay recorded outcomes.

## 7. Tests

| Command | What runs |
|---|---|
| `TEST_DATABASE_URL=… npm run check` | typecheck; all `tests/*.test.ts` (earlier suites unchanged; `tests/engine.test.ts` and `tests/engine-http.test.ts` on real PostgreSQL, skipped visibly without `TEST_DATABASE_URL`; `tests/web-components.test.ts` on jsdom); build; registry validation |
| `npm run test:browser` | `tests/browser/workspace.test.mjs` in real Chromium via Playwright with axe-core. Playwright/Chromium are not project dependencies: without them the tests report a visible skip |

Engine tests use several small real engines built with the kit (own schema each, real `StandardEngine`, cross-references,
compartments), one engine that is down and one that is not connected. Covered: graph/table/outline equivalence, depth and
size limits, cycles, forbidden vs missing, fail-closed authorization per method, tenant and project isolation through
every method, audit merge/paging/chain/export, controls with caller context and denial, saved-view revisions and
stale/blocked flags, annotations, HTTP end to end (in-process ports, and a standalone server reading engines over HTTP).
Browser tests cover keyboard-only graph and tab traversal, equivalence of table/text with the graph, the confirmation
dialog and its focus trap, real outcome/error display, states visible as text, axe (zero serious/critical; light and
dark), reflow at 640 px (200 % zoom of 1280) and 320 px, and timeline virtualisation with 5000 records.

## 8. Not implemented / not verified

- Not integration-tested against the real E00–E13 engines or inside PAM; only against in-test kit engines. Real-engine
  `ControlPort`s (pause/cancel/reassign/approve …) are the host's to supply.
- No push/streaming (`GET /v1/streams` lists sources; clients poll). No `projection.lagged` / `alert.raised` events, no
  alert panels, no event subscriptions.
- The catalog names a React interface; the component library is framework-free ES modules instead.
- No dedicated views for costs, rights, production or correspondence: those objects appear through the generic linked
  view, inspector, search, board and timeline as their engines describe them via `inspect`.
- Audit chain verification is limited to what the caller can read (see `chain`); descending timelines and exports are
  capped by `auditScanLimit` per engine.
- Accessibility was checked with axe-core and keyboard tests in Chromium only; no screen-reader, Firefox or Safari
  testing, and no independent accessibility or security review.
- The earlier opt-in modules in `src/` (inbox, reviews, operator clients …) are unchanged and are not wired into the
  service layer; they still import other engines' packages, the service layer does not.
- Not deployed or checked in a hosted environment.
