// E14 Visual Workspace and Audit — service layer.
// Aggregates other engines through ports (always with the caller's context) and persists only its own data:
// saved views, operator annotations, control invocations and its audit/outbox tables.
import { createHash, randomUUID } from 'node:crypto';
import { DomainError, invariant } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import {
  SERVICE_KIT_VERSION, appendAudit, emitEvent, errorStatus, hasCapability, idempotent, listAudit, parseUref, readEvents,
  requireCapability, runMigrations, standardRoutes, uref, urefMatches,
} from '../service-kit.ts';
import type {
  AuditRecord, EngineEvent, EngineManifestV1, HttpRequest, HttpResponse, Inspection, Migration, Route, SearchHit, ServiceContext,
  Sql, StandardEngine, UpstreamChange,
} from '../service-kit.ts';
import { DEFAULT_AGGREGATE_CONFIG, ENGINE_ID, callPort, createAggregator, isDomainError, withTimeout } from './aggregate.ts';
import type { AggregateConfig, AuditQuery, AuditTimeline, EnginePort, EngineRegistry, LinkedView, ObjectView, Overview, SearchAllResult, TimelineEngine } from './aggregate.ts';
import { deriveState, parseRef } from '../../web/model.js';
import type { DisplayState } from '../../web/model.js';

export type { AggregateConfig, AuditQuery, AuditTimeline, ChainStatus, EnginePort, EngineRegistry, LinkedView, ObjectView, Overview, OverviewCard, RefLink, SearchAllResult, SearchGroup, StateBadge, TimelineEngine, TimelineRecord } from './aggregate.ts';
export type { DisplayState, Graph, GraphEdge, GraphNode, Outline, OutlineLine, TableColumn, TableModel } from '../../web/model.js';

export const SCHEMA = 'e14_workspace';
const S = SCHEMA;

export const manifest: EngineManifestV1 = {
  id: ENGINE_ID, name: 'Visual workspace and audit', version: '1.0.0', kit: SERVICE_KIT_VERSION,
  capabilities: ['workspace:read', 'workspace:write', 'workspace:control', 'workspace:export', 'workspace:events'],
  emits: ['view.created', 'view.updated', 'view.archived', 'view.stale', 'view.blocked', 'view.flags_acknowledged', 'annotation.created', 'annotation.resolved', 'control.succeeded', 'control.failed', 'control.uncertain', 'audit.exported'],
  consumes: ['*.stale', '*.blocked', 'source_corrected', 'source_superseded', 'source_removed', 'permission_withdrawn', 'permission_changed', 'claim_changed', 'content_changed', 'render_changed', 'audience_changed', 'rights_changed'],
};

export const migrations: readonly Migration[] = [{ id: '001_workspace', sql: `
create table {s}.views (
  tenant_id text not null, project_id text not null, id uuid not null,
  revision int not null, name text not null, owner_id text not null,
  shared_roles text[] not null, editor_roles text[] not null, archived boolean not null default false,
  created_at timestamptz not null, updated_at timestamptz not null,
  primary key (tenant_id, project_id, id)
);
create table {s}.view_revisions (
  tenant_id text not null, project_id text not null, view_id uuid not null, revision int not null,
  name text not null, definition jsonb not null, shared_roles text[] not null, editor_roles text[] not null, archived boolean not null,
  actor_id text not null, at timestamptz not null, summary text not null,
  primary key (tenant_id, project_id, view_id, revision)
);
create table {s}.view_flags (
  id bigint generated always as identity primary key,
  tenant_id text not null, project_id text not null, view_id uuid not null, ref text not null,
  effect text not null check (effect in ('stale','blocked')), reason text not null, change_kind text not null,
  cause_event_id text not null, cause_ref text not null, flagged_at timestamptz not null,
  acknowledged_at timestamptz, acknowledged_by text, acknowledge_note text,
  unique (tenant_id, project_id, view_id, ref, cause_event_id)
);
create table {s}.upstream_changes (
  tenant_id text not null, project_id text not null, event_id text not null, affected jsonb not null, applied_at timestamptz not null,
  primary key (tenant_id, project_id, event_id)
);
create table {s}.annotations (
  tenant_id text not null, project_id text not null, id uuid not null,
  subject text not null, subject_key text not null,
  kind text not null check (kind in ('note','review','correction_request','flag')),
  body text not null, status text not null check (status in ('open','resolved')),
  author_id text not null, created_at timestamptz not null,
  resolved_at timestamptz, resolved_by text, resolution text,
  primary key (tenant_id, project_id, id)
);
create index annotations_subject on {s}.annotations (tenant_id, project_id, subject_key, created_at);
create table {s}.control_invocations (
  tenant_id text not null, project_id text not null, id uuid not null,
  subject text not null, control_id text not null, source text not null, capability text not null, dangerous boolean not null,
  input_digest text not null, idempotency_key text,
  outcome text not null check (outcome in ('attempted','succeeded','failed','denied','uncertain')),
  result jsonb, error_code text, error_message text,
  actor_id text not null, request_id text not null, started_at timestamptz not null, finished_at timestamptz,
  primary key (tenant_id, project_id, id)
);
create unique index control_invocations_key on {s}.control_invocations (tenant_id, project_id, idempotency_key) where idempotency_key is not null;
create index control_invocations_subject on {s}.control_invocations (tenant_id, project_id, subject, started_at);
` }];
export function migrate(sql: Sql): Promise<string[]> { return runMigrations(sql, SCHEMA, migrations); }

// ───────────────────────────── Types ─────────────────────────────
/** An action the host exposes for an object. `input` is a JSON-Schema-like object describing the form to show. */
export type ControlSpec = Readonly<{ id: string; label: string; capability: string; dangerous: boolean; input: Json; description?: string }>;
/** Supplied by the host: maps control ids to real engine methods. Always called with the caller's context. */
export interface ControlPort {
  controlsFor(ctx: ServiceContext, ref: string): Promise<ControlSpec[]>;
  invoke(ctx: ServiceContext, ref: string, controlId: string, input: Json): Promise<Json>;
}
export type ListedControl = ControlSpec & Readonly<{ source: string; allowed: boolean; deniedReason?: string }>;
export type ControlList = Readonly<{ ref: string; controls: ListedControl[]; unavailable: boolean; generatedAt: string }>;
export type ControlOutcome = 'attempted' | 'succeeded' | 'failed' | 'denied' | 'uncertain';
export type ControlInvocation = Readonly<{
  id: string; ref: string; subject: string; controlId: string; source: string; capability: string; dangerous: boolean; outcome: ControlOutcome;
  result: Json; error: { code: string; message: string } | null; actorId: string; requestId: string; startedAt: string; finishedAt: string | null;
}>;

export type ViewPin = Readonly<{ ref: string; label?: string; note?: string; x?: number; y?: number }>;
export type ViewInput = Readonly<{ name: string; pins?: readonly ViewPin[]; filters?: Json; layout?: Json; notes?: string; sharedRoles?: readonly string[]; editorRoles?: readonly string[] }>;
export type ViewFlag = Readonly<{ id: string; ref: string; effect: 'stale' | 'blocked'; reason: string; changeKind: string; causeEventId: string; causeRef: string; flaggedAt: string; acknowledgedAt: string | null; acknowledgedBy: string | null }>;
export type SavedView = Readonly<{
  id: string; ref: string; revision: number; currentRevision: number; name: string; ownerId: string; sharedRoles: string[]; editorRoles: string[]; archived: boolean;
  pins: ViewPin[]; filters: Json; layout: Json; notes: string;
  /** Derived from unacknowledged flags on refs pinned in the current revision. */
  stale: boolean; blocked: boolean; flags: ViewFlag[];
  canEdit: boolean; createdAt: string; updatedAt: string;
}>;
export type ViewRevisionInfo = Readonly<{ revision: number; at: string; actorId: string; summary: string; name: string; archived: boolean }>;
export type BoardPin = ViewPin & Readonly<{
  engine: string; kind: string; title: string; state: DisplayState; engineState: string; stale: boolean; blocked: boolean; staleReasons: string[]; flags: ViewFlag[];
}>;
export type Board = Readonly<{ view: SavedView; pins: BoardPin[]; unavailableEngines: string[]; generatedAt: string }>;
export type AnnotationKind = 'note' | 'review' | 'correction_request' | 'flag';
export type Annotation = Readonly<{
  id: string; ref: string; subject: string; kind: AnnotationKind; body: string; status: 'open' | 'resolved';
  authorId: string; createdAt: string; resolvedAt: string | null; resolvedBy: string | null; resolution: string | null;
}>;
export type AuditExport = Readonly<{ id: string; format: 'csv' | 'json'; mediaType: string; filename: string; content: string; sha256: string; recordCount: number; truncated: boolean; engines: TimelineEngine[] }>;

export type EngineConfig = Partial<AggregateConfig> & Readonly<{ controlTimeoutMs?: number }>;
export type EngineDeps = Readonly<{
  sql: Sql;
  ports?: Readonly<{ engines?: EngineRegistry; controls?: Readonly<Record<string, ControlPort>> }>;
  config?: EngineConfig;
}>;

export interface WorkspaceEngine extends StandardEngine {
  inspectLinked(ctx: ServiceContext, ref: string, options?: { depth?: number; direction?: 'both' | 'upstream' | 'downstream'; maxNodes?: number }): Promise<LinkedView>;
  inspectOne(ctx: ServiceContext, ref: string): Promise<ObjectView & { annotations: Annotation[] }>;
  searchAll(ctx: ServiceContext, query: { q: string; engines?: readonly string[]; limit?: number }): Promise<SearchAllResult>;
  auditTimeline(ctx: ServiceContext, query?: AuditQuery): Promise<AuditTimeline>;
  exportAudit(ctx: ServiceContext, query?: AuditQuery & { format?: 'csv' | 'json'; includeDetail?: boolean }): Promise<AuditExport>;
  overview(ctx: ServiceContext): Promise<Overview>;
  listEngines(ctx: ServiceContext): Promise<{ engine: string; name: string; version: string; emits: string[]; controls: boolean }[]>;
  createView(ctx: ServiceContext, input: ViewInput & { idempotencyKey?: string }): Promise<SavedView>;
  updateView(ctx: ServiceContext, id: string, patch: Partial<ViewInput> & { expectedRevision: number; summary?: string; idempotencyKey?: string }): Promise<SavedView>;
  archiveView(ctx: ServiceContext, id: string, options: { expectedRevision: number; archived?: boolean }): Promise<SavedView>;
  getView(ctx: ServiceContext, id: string, options?: { revision?: number }): Promise<SavedView>;
  listViews(ctx: ServiceContext, options?: { includeArchived?: boolean; limit?: number }): Promise<SavedView[]>;
  listViewRevisions(ctx: ServiceContext, id: string): Promise<ViewRevisionInfo[]>;
  resolveView(ctx: ServiceContext, id: string): Promise<Board>;
  acknowledgeViewFlags(ctx: ServiceContext, id: string, options?: { refs?: readonly string[]; note?: string }): Promise<SavedView>;
  annotate(ctx: ServiceContext, input: { ref: string; kind?: AnnotationKind; body: string; idempotencyKey?: string }): Promise<Annotation>;
  resolveAnnotation(ctx: ServiceContext, id: string, input?: { resolution?: string }): Promise<Annotation>;
  listAnnotations(ctx: ServiceContext, options?: { ref?: string; status?: 'open' | 'resolved'; limit?: number }): Promise<{ annotations: Annotation[]; unavailableEngines: string[] }>;
  listControls(ctx: ServiceContext, ref: string): Promise<ControlList>;
  invokeControl(ctx: ServiceContext, ref: string, controlId: string, input?: Json, options?: { confirm?: boolean; idempotencyKey?: string }): Promise<ControlInvocation>;
  listControlInvocations(ctx: ServiceContext, options?: { ref?: string; limit?: number }): Promise<ControlInvocation[]>;
}

// ───────────────────────────── Validation helpers ─────────────────────────────
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const text = (value: unknown, label: string, max: number, min = 1): string => {
  invariant(typeof value === 'string' && value.trim().length >= min && value.length <= max, 'invalid_input', `${label} must be ${min} to ${max} characters`);
  return value;
};
const roles = (value: unknown, label: string): string[] => {
  if (value === undefined) return [];
  invariant(Array.isArray(value) && value.length <= 50 && value.every((r) => typeof r === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(r)), 'invalid_input', `${label} must be a list of at most 50 role names`);
  return [...new Set(value as string[])].sort();
};
const jsonValue = (value: unknown, label: string, maxBytes: number): Json => {
  if (value === undefined) return {};
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { throw new DomainError('invalid_input', `${label} must be JSON`); }
  invariant(typeof encoded === 'string' && encoded.length <= maxBytes, 'invalid_input', `${label} is too large`);
  return JSON.parse(encoded) as Json;
};
function pins(value: unknown): ViewPin[] {
  if (value === undefined) return [];
  invariant(Array.isArray(value) && value.length <= 500, 'invalid_input', 'pins must be a list of at most 500 entries');
  const seen = new Set<string>();
  return value.map((raw: unknown) => {
    invariant(raw !== null && typeof raw === 'object' && !Array.isArray(raw), 'invalid_input', 'Each pin must be an object');
    const p = raw as Record<string, unknown>;
    invariant(typeof p.ref === 'string', 'invalid_input', 'Each pin needs a ref');
    parseUref(p.ref);
    invariant(!seen.has(p.ref), 'invalid_input', 'A reference can be pinned once per view');
    seen.add(p.ref);
    const coord = (v: unknown, label: string): number | undefined => { if (v === undefined || v === null) return undefined; invariant(typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6, 'invalid_input', `${label} must be a finite number`); return v; };
    const x = coord(p.x, 'x'), y = coord(p.y, 'y');
    return {
      ref: p.ref, ...(p.label === undefined ? {} : { label: text(p.label, 'pin label', 200) }), ...(p.note === undefined ? {} : { note: text(p.note, 'pin note', 2000, 0) }),
      ...(x === undefined ? {} : { x }), ...(y === undefined ? {} : { y }),
    };
  });
}
const iso = (value: unknown): string => new Date(value as string | Date).toISOString();
const isoOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : iso(value));
const sc = (ctx: ServiceContext): [string, string] => [ctx.tenantId, ctx.projectId];
const like = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const subjectKey = (ref: string): string => { const p = parseUref(ref); return `${p.engine}:${p.kind}:${p.id}`; };

/** Checks an input object against the small JSON-Schema subset used by control specs. */
export function validateControlInput(schema: Json, input: Json): void {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object') return;
  invariant(input !== null && typeof input === 'object' && !Array.isArray(input), 'invalid_input', 'Control input must be an object');
  const props = (schema.properties !== null && typeof schema.properties === 'object' && !Array.isArray(schema.properties) ? schema.properties : {}) as Record<string, Json>;
  for (const name of Array.isArray(schema.required) ? schema.required : []) invariant(typeof name === 'string' && input[name] !== undefined && input[name] !== null && input[name] !== '', 'invalid_input', `Missing required input ${String(name)}`);
  if (schema.additionalProperties === false) for (const k of Object.keys(input)) invariant(Object.hasOwn(props, k), 'invalid_input', `Unknown input ${k}`);
  for (const [name, raw] of Object.entries(props)) {
    const value = input[name];
    if (value === undefined || value === null || raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const type = raw.type;
    const ok = type === 'string' ? typeof value === 'string' : type === 'boolean' ? typeof value === 'boolean' : type === 'integer' ? typeof value === 'number' && Number.isInteger(value)
      : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : true;
    invariant(ok, 'invalid_input', `Input ${name} must be of type ${String(type)}`);
    if (Array.isArray(raw.enum)) invariant(raw.enum.includes(value), 'invalid_input', `Input ${name} is not one of the allowed values`);
    if (typeof value === 'string' && typeof raw.maxLength === 'number') invariant(value.length <= raw.maxLength, 'invalid_input', `Input ${name} is too long`);
  }
}
function validSpec(spec: unknown): spec is ControlSpec {
  if (spec === null || typeof spec !== 'object') return false;
  const s = spec as Record<string, unknown>;
  return typeof s.id === 'string' && /^[a-z][a-z0-9_.-]{0,80}$/.test(s.id) && !s.id.startsWith('workspace.') && typeof s.label === 'string' && s.label.length > 0 && s.label.length <= 200
    && typeof s.capability === 'string' && /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/.test(s.capability) && typeof s.dangerous === 'boolean';
}

const BUILTIN_CONTROLS: readonly ControlSpec[] = [
  { id: 'workspace.review_note', label: 'Add review note', capability: 'workspace:write', dangerous: false, description: 'Records a review note on this object in the workspace. It does not change the object.',
    input: { type: 'object', required: ['body'], additionalProperties: false, properties: { body: { type: 'string', title: 'Review note', maxLength: 4000 } } } },
  { id: 'workspace.request_correction', label: 'Request correction', capability: 'workspace:write', dangerous: false, description: 'Records a correction request on this object in the workspace for the owning team. The owning engine is not changed by this action.',
    input: { type: 'object', required: ['body'], additionalProperties: false, properties: { body: { type: 'string', title: 'What needs correcting', maxLength: 4000 } } } },
  { id: 'workspace.export_audit', label: 'Export audit history', capability: 'workspace:export', dangerous: false, description: 'Exports the audit records about this object that you are permitted to read.',
    input: { type: 'object', additionalProperties: false, properties: { format: { type: 'string', title: 'Format', enum: ['csv', 'json'] } } } },
];

// ───────────────────────────── Engine ─────────────────────────────
export function createEngine(deps: EngineDeps): WorkspaceEngine {
  const sql = deps.sql;
  const config: AggregateConfig = { ...DEFAULT_AGGREGATE_CONFIG, ...Object.fromEntries(Object.entries(deps.config ?? {}).filter(([k, v]) => k !== 'controlTimeoutMs' && v !== undefined)) };
  const controlTimeoutMs = deps.config?.controlTimeoutMs ?? 30_000;
  const controlPorts = deps.ports?.controls ?? {};
  const read = (ctx: ServiceContext): void => requireCapability(ctx, 'workspace:read');
  const write = (ctx: ServiceContext): void => requireCapability(ctx, 'workspace:write');
  const notFound = (): never => { throw new DomainError('not_found', 'Not found'); };
  const viewRef = (id: string, revision?: number): string => uref(ENGINE_ID, 'view', id, revision);

  // ── Saved views ──
  type ViewRow = { id: string; revision: number; name: string; owner_id: string; shared_roles: string[]; editor_roles: string[]; archived: boolean; created_at: Date; updated_at: Date };
  type Definition = { pins: ViewPin[]; filters: Json; layout: Json; notes: string };
  const canEdit = (ctx: ServiceContext, v: ViewRow): boolean => v.owner_id === ctx.actor.id || v.editor_roles.some((r) => ctx.actor.roles.includes(r));
  const canRead = (ctx: ServiceContext, v: ViewRow): boolean => canEdit(ctx, v) || v.shared_roles.some((r) => ctx.actor.roles.includes(r));
  const toFlag = (r: Record<string, unknown>): ViewFlag => ({ id: String(r.id), ref: r.ref as string, effect: r.effect as 'stale' | 'blocked', reason: r.reason as string, changeKind: r.change_kind as string, causeEventId: r.cause_event_id as string, causeRef: r.cause_ref as string, flaggedAt: iso(r.flagged_at), acknowledgedAt: isoOrNull(r.acknowledged_at), acknowledgedBy: (r.acknowledged_by as string | null) ?? null });

  async function viewRow(q: Sql, ctx: ServiceContext, id: string, lock = false): Promise<ViewRow> {
    if (typeof id !== 'string' || !UUID.test(id)) return notFound();
    const row = (await q.query<ViewRow>(`select id, revision, name, owner_id, shared_roles, editor_roles, archived, created_at, updated_at from ${S}.views where tenant_id=$1 and project_id=$2 and id=$3${lock ? ' for update' : ''}`, [...sc(ctx), id]))[0];
    if (row === undefined || !canRead(ctx, row)) return notFound();
    return row;
  }
  async function openFlags(q: Sql, ctx: ServiceContext, ids: readonly string[]): Promise<Map<string, ViewFlag[]>> {
    const out = new Map<string, ViewFlag[]>();
    if (ids.length === 0) return out;
    const rows = await q.query(`select id::text as id, view_id, ref, effect, reason, change_kind, cause_event_id, cause_ref, flagged_at, acknowledged_at, acknowledged_by from ${S}.view_flags where tenant_id=$1 and project_id=$2 and view_id = any($3::uuid[]) and acknowledged_at is null order by id`, [...sc(ctx), [...ids]]);
    for (const r of rows) { const list = out.get(r.view_id as string) ?? []; list.push(toFlag(r)); out.set(r.view_id as string, list); }
    return out;
  }
  async function loadView(q: Sql, ctx: ServiceContext, row: ViewRow, revision?: number, flagMap?: Map<string, ViewFlag[]>): Promise<SavedView> {
    const rev = (await q.query<{ revision: number; name: string; definition: Definition; shared_roles: string[]; editor_roles: string[]; archived: boolean }>(
      `select revision, name, definition, shared_roles, editor_roles, archived from ${S}.view_revisions where tenant_id=$1 and project_id=$2 and view_id=$3 and revision=$4`, [...sc(ctx), row.id, revision ?? row.revision]))[0];
    if (rev === undefined) return notFound();
    const current = rev.revision === row.revision;
    const pinned = new Set(rev.definition.pins.map((p) => p.ref));
    const flags = current ? ((flagMap ?? await openFlags(q, ctx, [row.id])).get(row.id) ?? []).filter((f) => pinned.has(f.ref)) : [];
    return {
      id: row.id, ref: viewRef(row.id, rev.revision), revision: rev.revision, currentRevision: row.revision, name: rev.name, ownerId: row.owner_id,
      sharedRoles: rev.shared_roles, editorRoles: rev.editor_roles, archived: rev.archived,
      pins: rev.definition.pins, filters: rev.definition.filters, layout: rev.definition.layout, notes: rev.definition.notes,
      stale: flags.some((f) => f.effect === 'stale'), blocked: flags.some((f) => f.effect === 'blocked'), flags,
      canEdit: canEdit(ctx, row), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    };
  }
  async function writeRevision(tx: Sql, ctx: ServiceContext, id: string, revision: number, name: string, def: Definition, shared: string[], editors: string[], archived: boolean, summary: string): Promise<void> {
    await tx.query(`insert into ${S}.view_revisions (tenant_id, project_id, view_id, revision, name, definition, shared_roles, editor_roles, archived, actor_id, at, summary) values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)`,
      [...sc(ctx), id, revision, name, JSON.stringify(def), shared, editors, archived, ctx.actor.id, ctx.now, summary]);
  }

  async function createView(ctx: ServiceContext, input: ViewInput & { idempotencyKey?: string }): Promise<SavedView> {
    write(ctx);
    invariant(input !== null && typeof input === 'object', 'invalid_input', 'View input required');
    const name = text(input.name, 'name', 200);
    const def: Definition = { pins: pins(input.pins), filters: jsonValue(input.filters, 'filters', 16_384), layout: jsonValue(input.layout, 'layout', 65_536), notes: input.notes === undefined ? '' : text(input.notes, 'notes', 20_000, 0) };
    const shared = roles(input.sharedRoles, 'sharedRoles'), editors = roles(input.editorRoles, 'editorRoles');
    const { idempotencyKey, ...body } = input;
    return sql.tx((tx) => idempotent(tx, S, ctx, idempotencyKey === undefined ? undefined : `view.create:${ctx.actor.id}:${idempotencyKey}`, body, async () => {
      const id = randomUUID();
      await tx.query(`insert into ${S}.views (tenant_id, project_id, id, revision, name, owner_id, shared_roles, editor_roles, created_at, updated_at) values ($1,$2,$3,1,$4,$5,$6,$7,$8,$8)`, [...sc(ctx), id, name, ctx.actor.id, shared, editors, ctx.now]);
      await writeRevision(tx, ctx, id, 1, name, def, shared, editors, false, 'Created');
      await appendAudit(tx, S, ctx, 'view.created', viewRef(id), { revision: 1, pins: def.pins.length });
      await emitEvent(tx, S, ctx, 'view.created', viewRef(id, 1), { revision: 1 });
      return await loadView(tx, ctx, await viewRow(tx, ctx, id)) as unknown as Json;
    })) as unknown as Promise<SavedView>;
  }
  async function reviseView(ctx: ServiceContext, id: string, expectedRevision: number, key: string | undefined, body: unknown, action: 'view.updated' | 'view.archived', change: (row: ViewRow, def: Definition) => { name: string; def: Definition; shared: string[]; editors: string[]; archived: boolean; summary: string }): Promise<SavedView> {
    write(ctx);
    invariant(Number.isInteger(expectedRevision) && expectedRevision > 0, 'invalid_input', 'expectedRevision must be a positive integer');
    return sql.tx((tx) => idempotent(tx, S, ctx, key === undefined ? undefined : `view.update:${id}:${ctx.actor.id}:${key}`, body, async () => {
      const row = await viewRow(tx, ctx, id, true);
      if (!canEdit(ctx, row)) throw new DomainError('forbidden', 'This view is shared with you read-only');
      if (row.revision !== expectedRevision) throw new DomainError('revision_conflict', `View is at revision ${row.revision}`);
      const current = await loadView(tx, ctx, row);
      const next = change(row, { pins: current.pins, filters: current.filters, layout: current.layout, notes: current.notes });
      // Only the owner changes who the view is shared with.
      if (row.owner_id !== ctx.actor.id && (next.shared.join() !== row.shared_roles.join() || next.editors.join() !== row.editor_roles.join())) throw new DomainError('forbidden', 'Only the owner can change sharing');
      const revision = row.revision + 1;
      await tx.query(`update ${S}.views set revision=$4, name=$5, shared_roles=$6, editor_roles=$7, archived=$8, updated_at=$9 where tenant_id=$1 and project_id=$2 and id=$3`, [...sc(ctx), id, revision, next.name, next.shared, next.editors, next.archived, ctx.now]);
      await writeRevision(tx, ctx, id, revision, next.name, next.def, next.shared, next.editors, next.archived, next.summary);
      await appendAudit(tx, S, ctx, action, viewRef(id), { revision, pins: next.def.pins.length, summary: next.summary });
      await emitEvent(tx, S, ctx, action, viewRef(id, revision), { revision });
      return await loadView(tx, ctx, await viewRow(tx, ctx, id)) as unknown as Json;
    })) as unknown as Promise<SavedView>;
  }
  function updateView(ctx: ServiceContext, id: string, patch: Partial<ViewInput> & { expectedRevision: number; summary?: string; idempotencyKey?: string }): Promise<SavedView> {
    invariant(patch !== null && typeof patch === 'object', 'invalid_input', 'Patch required');
    const { idempotencyKey, ...body } = patch;
    return reviseView(ctx, id, patch.expectedRevision, idempotencyKey, body, 'view.updated', (row, def) => ({
      name: patch.name === undefined ? row.name : text(patch.name, 'name', 200),
      def: {
        pins: patch.pins === undefined ? def.pins : pins(patch.pins), filters: patch.filters === undefined ? def.filters : jsonValue(patch.filters, 'filters', 16_384),
        layout: patch.layout === undefined ? def.layout : jsonValue(patch.layout, 'layout', 65_536), notes: patch.notes === undefined ? def.notes : text(patch.notes, 'notes', 20_000, 0),
      },
      shared: patch.sharedRoles === undefined ? row.shared_roles : roles(patch.sharedRoles, 'sharedRoles'), editors: patch.editorRoles === undefined ? row.editor_roles : roles(patch.editorRoles, 'editorRoles'),
      archived: row.archived, summary: patch.summary === undefined ? 'Updated' : text(patch.summary, 'summary', 500),
    }));
  }
  function archiveView(ctx: ServiceContext, id: string, options: { expectedRevision: number; archived?: boolean }): Promise<SavedView> {
    invariant(options !== null && typeof options === 'object', 'invalid_input', 'expectedRevision required');
    const archived = options.archived !== false;
    return reviseView(ctx, id, options.expectedRevision, undefined, null, 'view.archived', (row, def) => ({ name: row.name, def, shared: row.shared_roles, editors: row.editor_roles, archived, summary: archived ? 'Archived' : 'Restored' }));
  }
  async function getView(ctx: ServiceContext, id: string, options: { revision?: number } = {}): Promise<SavedView> {
    read(ctx);
    if (options.revision !== undefined) invariant(Number.isInteger(options.revision) && options.revision > 0, 'invalid_input', 'revision must be a positive integer');
    return loadView(sql, ctx, await viewRow(sql, ctx, id), options.revision);
  }
  async function listViews(ctx: ServiceContext, options: { includeArchived?: boolean; limit?: number } = {}): Promise<SavedView[]> {
    read(ctx);
    const limit = Math.min(Math.max(Number.isInteger(options.limit) ? options.limit as number : 100, 1), 500);
    const rows = await sql.query<ViewRow>(`select id, revision, name, owner_id, shared_roles, editor_roles, archived, created_at, updated_at from ${S}.views
      where tenant_id=$1 and project_id=$2 and ($3 or not archived) and (owner_id=$4 or shared_roles && $5::text[] or editor_roles && $5::text[]) order by updated_at desc, id limit ${limit}`,
      [...sc(ctx), options.includeArchived === true, ctx.actor.id, [...ctx.actor.roles]]);
    const flags = await openFlags(sql, ctx, rows.map((r) => r.id));
    return Promise.all(rows.map((r) => loadView(sql, ctx, r, undefined, flags)));
  }
  async function listViewRevisions(ctx: ServiceContext, id: string): Promise<ViewRevisionInfo[]> {
    read(ctx);
    const row = await viewRow(sql, ctx, id);
    return (await sql.query(`select revision, at, actor_id, summary, name, archived from ${S}.view_revisions where tenant_id=$1 and project_id=$2 and view_id=$3 order by revision`, [...sc(ctx), row.id]))
      .map((r) => ({ revision: r.revision as number, at: iso(r.at), actorId: r.actor_id as string, summary: r.summary as string, name: r.name as string, archived: r.archived as boolean }));
  }
  async function resolveView(ctx: ServiceContext, id: string): Promise<Board> {
    const view = await getView(ctx, id);
    const unavailable = new Set<string>();
    const out: BoardPin[] = [];
    for (let i = 0; i < view.pins.length; i += config.concurrency) {
      out.push(...await Promise.all(view.pins.slice(i, i + config.concurrency).map(async (pin): Promise<BoardPin> => {
        const parsed = parseUref(pin.ref);
        const flags = view.flags.filter((f) => f.ref === pin.ref);
        const base = { ...pin, engine: parsed.engine, kind: parsed.kind, title: '', engineState: '', stale: false, blocked: false, staleReasons: [] as string[], flags };
        const result = await aggregator.inspectRef(ctx, pin.ref);
        if (result.status === 'unavailable') { unavailable.add(parsed.engine); return { ...base, state: 'unavailable' }; }
        if (result.status === 'forbidden' || result.value === null) return { ...base, state: 'forbidden_or_missing' };
        const i2 = result.value;
        return { ...base, kind: String(i2.kind ?? parsed.kind), title: String(i2.title ?? ''), state: deriveState(i2), engineState: String(i2.state ?? ''), stale: i2.stale === true, blocked: i2.blocked === true, staleReasons: Array.isArray(i2.staleReasons) ? i2.staleReasons.filter((x) => typeof x === 'string') : [] };
      })));
    }
    return { view, pins: out, unavailableEngines: [...unavailable].sort(), generatedAt: ctx.now };
  }
  async function acknowledgeViewFlags(ctx: ServiceContext, id: string, options: { refs?: readonly string[]; note?: string } = {}): Promise<SavedView> {
    write(ctx);
    const refs = options.refs === undefined ? null : [...options.refs];
    if (refs !== null) { invariant(refs.length <= 500 && refs.every((r) => typeof r === 'string'), 'invalid_input', 'refs must be a list of references'); refs.forEach((r) => parseUref(r)); }
    const note = options.note === undefined ? null : text(options.note, 'note', 2000, 0);
    return sql.tx(async (tx) => {
      const row = await viewRow(tx, ctx, id, true);
      if (!canEdit(ctx, row)) throw new DomainError('forbidden', 'This view is shared with you read-only');
      const done = await tx.query<{ ref: string }>(`update ${S}.view_flags set acknowledged_at=$4, acknowledged_by=$5, acknowledge_note=$6 where tenant_id=$1 and project_id=$2 and view_id=$3 and acknowledged_at is null and ($7::text[] is null or ref = any($7)) returning ref`,
        [...sc(ctx), id, ctx.now, ctx.actor.id, note, refs]);
      if (done.length > 0) {
        await appendAudit(tx, S, ctx, 'view.flags_acknowledged', viewRef(id), { refs: [...new Set(done.map((d) => d.ref))].sort(), note: note !== null && note !== '' });
        await emitEvent(tx, S, ctx, 'view.flags_acknowledged', viewRef(id, row.revision), { count: done.length });
      }
      return loadView(tx, ctx, row);
    });
  }

  // ── Annotations ──
  const toAnnotation = (r: Record<string, unknown>): Annotation => ({ id: r.id as string, ref: uref(ENGINE_ID, 'annotation', r.id as string), subject: r.subject as string, kind: r.kind as AnnotationKind, body: r.body as string, status: r.status as 'open' | 'resolved', authorId: r.author_id as string, createdAt: iso(r.created_at), resolvedAt: isoOrNull(r.resolved_at), resolvedBy: (r.resolved_by as string | null) ?? null, resolution: (r.resolution as string | null) ?? null });
  /** An annotation is only as visible as its subject: the caller must be able to inspect the object it is about. */
  async function requireVisible(ctx: ServiceContext, ref: string): Promise<void> {
    const engine = parseUref(ref).engine;
    const seen = await aggregator.visibility(ctx, ref);
    if (seen === 'unavailable') throw new DomainError('unavailable', `Engine ${engine} is unavailable; visibility of this object cannot be confirmed`);
    if (seen === 'hidden') notFound();
  }
  async function annotate(ctx: ServiceContext, input: { ref: string; kind?: AnnotationKind; body: string; idempotencyKey?: string }): Promise<Annotation> {
    write(ctx);
    invariant(input !== null && typeof input === 'object' && typeof input.ref === 'string', 'invalid_input', 'ref required');
    const kind = input.kind ?? 'note';
    invariant(['note', 'review', 'correction_request', 'flag'].includes(kind), 'invalid_input', 'Unknown annotation kind');
    const body = text(input.body, 'body', 4000);
    await requireVisible(ctx, input.ref);
    return sql.tx((tx) => idempotent(tx, S, ctx, input.idempotencyKey === undefined ? undefined : `annotation:${ctx.actor.id}:${input.idempotencyKey}`, { ref: input.ref, kind, body }, async () => {
      const id = randomUUID();
      const row = (await tx.query(`insert into ${S}.annotations (tenant_id, project_id, id, subject, subject_key, kind, body, status, author_id, created_at) values ($1,$2,$3,$4,$5,$6,$7,'open',$8,$9) returning *`, [...sc(ctx), id, input.ref, subjectKey(input.ref), kind, body, ctx.actor.id, ctx.now]))[0] as Record<string, unknown>;
      // The audit trail records that a note exists and what it is about, not its text.
      await appendAudit(tx, S, ctx, 'annotation.created', input.ref, { annotation: id, kind });
      await emitEvent(tx, S, ctx, 'annotation.created', uref(ENGINE_ID, 'annotation', id), { subject: input.ref, kind });
      return toAnnotation(row) as unknown as Json;
    })) as unknown as Promise<Annotation>;
  }
  async function resolveAnnotation(ctx: ServiceContext, id: string, input: { resolution?: string } = {}): Promise<Annotation> {
    write(ctx);
    if (typeof id !== 'string' || !UUID.test(id)) notFound();
    const resolution = input.resolution === undefined ? '' : text(input.resolution, 'resolution', 2000, 0);
    const existing = (await sql.query(`select * from ${S}.annotations where tenant_id=$1 and project_id=$2 and id=$3`, [...sc(ctx), id]))[0];
    if (existing === undefined) return notFound();
    await requireVisible(ctx, existing.subject as string);
    return sql.tx(async (tx) => {
      const row = (await tx.query(`update ${S}.annotations set status='resolved', resolved_at=$4, resolved_by=$5, resolution=$6 where tenant_id=$1 and project_id=$2 and id=$3 and status='open' returning *`, [...sc(ctx), id, ctx.now, ctx.actor.id, resolution]))[0];
      if (row === undefined) throw new DomainError('invalid_state', 'Annotation is already resolved');
      await appendAudit(tx, S, ctx, 'annotation.resolved', row.subject as string, { annotation: id });
      await emitEvent(tx, S, ctx, 'annotation.resolved', uref(ENGINE_ID, 'annotation', id), { subject: row.subject as string });
      return toAnnotation(row);
    });
  }
  async function annotationsFor(ctx: ServiceContext, ref: string, limit = 200): Promise<Annotation[]> {
    return (await sql.query(`select * from ${S}.annotations where tenant_id=$1 and project_id=$2 and subject_key=$3 order by created_at desc, id limit ${limit}`, [...sc(ctx), subjectKey(ref)])).map(toAnnotation);
  }
  /** Filters rows to those whose subject the caller can inspect right now. */
  async function visibleOnly<T>(ctx: ServiceContext, rows: readonly T[], subjectOf: (row: T) => string): Promise<{ rows: T[]; unavailable: string[] }> {
    const verdict = new Map<string, 'visible' | 'hidden' | 'unavailable'>();
    const subjects = [...new Set(rows.map(subjectOf))];
    for (let i = 0; i < subjects.length; i += config.concurrency) {
      await Promise.all(subjects.slice(i, i + config.concurrency).map(async (s) => { verdict.set(s, parseRef(s) === null ? 'hidden' : await aggregator.visibility(ctx, s)); }));
    }
    const unavailable = new Set<string>();
    for (const [s, v] of verdict) if (v === 'unavailable') unavailable.add((parseRef(s) as { engine: string }).engine);
    return { rows: rows.filter((r) => verdict.get(subjectOf(r)) === 'visible'), unavailable: [...unavailable].sort() };
  }
  async function listAnnotations(ctx: ServiceContext, options: { ref?: string; status?: 'open' | 'resolved'; limit?: number } = {}): Promise<{ annotations: Annotation[]; unavailableEngines: string[] }> {
    read(ctx);
    const limit = Math.min(Math.max(Number.isInteger(options.limit) ? options.limit as number : 100, 1), 200);
    if (options.status !== undefined) invariant(options.status === 'open' || options.status === 'resolved', 'invalid_input', 'status must be open or resolved');
    if (options.ref !== undefined) {
      await requireVisible(ctx, options.ref);
      return { annotations: (await annotationsFor(ctx, options.ref, limit)).filter((a) => options.status === undefined || a.status === options.status), unavailableEngines: [] };
    }
    const rows = (await sql.query(`select * from ${S}.annotations where tenant_id=$1 and project_id=$2 and ($3::text is null or status=$3) order by created_at desc, id limit ${limit}`, [...sc(ctx), options.status ?? null])).map(toAnnotation);
    const seen = await visibleOnly(ctx, rows, (a) => a.subject);
    return { annotations: seen.rows, unavailableEngines: seen.unavailable };
  }

  // ── Own standard surface ──
  async function ownHistory(ctx: ServiceContext, subject: string): Promise<Inspection['history']> {
    return (await listAudit(sql, S, ctx, { subject, limit: 200 })).map((a) => ({ at: a.at, actorId: a.actorId, action: a.action, detail: a.detail }));
  }
  async function inspect(ctx: ServiceContext, ref: string): Promise<Inspection | null> {
    read(ctx);
    const p = parseRef(ref);
    if (p === null || p.engine !== ENGINE_ID) return null;
    try {
      if (p.kind === 'view') {
        const row = await viewRow(sql, ctx, p.id);
        if (p.revision !== undefined && p.revision > row.revision) return null;
        const view = await loadView(sql, ctx, row, p.revision);
        const revisions = await listViewRevisions(ctx, p.id);
        const acknowledged = await sql.query(`select ref, acknowledged_at, acknowledged_by, cause_event_id from ${S}.view_flags where tenant_id=$1 and project_id=$2 and view_id=$3 and acknowledged_at is not null order by id`, [...sc(ctx), p.id]);
        return {
          ref: view.ref, kind: 'view', title: view.name, state: view.archived ? 'archived' : 'active', stale: view.stale, blocked: view.blocked,
          staleReasons: view.flags.map((f) => `${f.ref}: ${f.reason}`),
          versions: revisions.map((r) => ({ revision: r.revision, at: r.at, actorId: r.actorId, summary: r.summary })),
          sources: view.pins.map((x) => x.ref), dependents: [],
          permissions: [{ ownerId: view.ownerId, sharedRoles: view.sharedRoles, editorRoles: view.editorRoles }],
          decisions: acknowledged.map((a) => ({ type: 'flag_acknowledged', ref: a.ref as string, by: a.acknowledged_by as string, at: iso(a.acknowledged_at), cause: a.cause_event_id as string })),
          history: await ownHistory(ctx, viewRef(p.id)), data: { notes: view.notes, filters: view.filters, pins: view.pins as unknown as Json, currentRevision: view.currentRevision },
        };
      }
      if (p.kind === 'annotation' || p.kind === 'control_invocation') {
        if (!UUID.test(p.id)) return null;
        const table = p.kind === 'annotation' ? 'annotations' : 'control_invocations';
        const row = (await sql.query(`select * from ${S}.${table} where tenant_id=$1 and project_id=$2 and id=$3`, [...sc(ctx), p.id]))[0];
        if (row === undefined || await aggregator.visibility(ctx, row.subject as string) !== 'visible') return null;
        if (p.kind === 'annotation') {
          const a = toAnnotation(row);
          return { ref: a.ref, kind: 'annotation', title: `${a.kind.replace('_', ' ')} on ${a.subject}`, state: a.status, stale: false, blocked: false, staleReasons: [], versions: [{ revision: 1, at: a.createdAt, actorId: a.authorId }], sources: [a.subject], dependents: [], permissions: [],
            decisions: a.resolvedAt === null ? [] : [{ type: 'resolved', by: a.resolvedBy, at: a.resolvedAt, resolution: a.resolution }],
            history: [{ at: a.createdAt, actorId: a.authorId, action: 'annotation.created' }, ...(a.resolvedAt === null ? [] : [{ at: a.resolvedAt, actorId: a.resolvedBy as string, action: 'annotation.resolved' }])], data: { kind: a.kind, body: a.body } };
        }
        const c = toInvocation(row);
        return { ref: c.ref, kind: 'control_invocation', title: `${c.controlId} on ${c.subject}`, state: c.outcome, stale: false, blocked: false, staleReasons: [], versions: [{ revision: 1, at: c.startedAt, actorId: c.actorId }], sources: [c.subject], dependents: [],
          permissions: [{ capability: c.capability }], decisions: [], history: [{ at: c.startedAt, actorId: c.actorId, action: 'control.attempted' }, ...(c.finishedAt === null ? [] : [{ at: c.finishedAt, actorId: c.actorId, action: `control.${c.outcome}` }])],
          data: { controlId: c.controlId, source: c.source, dangerous: c.dangerous, error: c.error } };
      }
      return null;
    } catch (error) {
      if (error instanceof DomainError && error.code === 'not_found') return null;
      throw error;
    }
  }
  async function search(ctx: ServiceContext, query: { q: string; limit?: number }): Promise<SearchHit[]> {
    read(ctx);
    invariant(query !== null && typeof query === 'object' && typeof query.q === 'string' && query.q.length <= 500, 'invalid_input', 'q must be at most 500 characters');
    if (query.q.trim() === '') return [];
    const limit = Math.min(Math.max(Number.isInteger(query.limit) ? query.limit as number : 20, 1), 100);
    const views = await sql.query(`select v.id, v.revision, v.name, v.archived, r.definition->>'notes' as notes from ${S}.views v join ${S}.view_revisions r on r.tenant_id=v.tenant_id and r.project_id=v.project_id and r.view_id=v.id and r.revision=v.revision
      where v.tenant_id=$1 and v.project_id=$2 and (v.owner_id=$3 or v.shared_roles && $4::text[] or v.editor_roles && $4::text[]) and (v.name ilike $5 or r.definition->>'notes' ilike $5) order by v.updated_at desc, v.id limit ${limit}`,
      [...sc(ctx), ctx.actor.id, [...ctx.actor.roles], like(query.q)]);
    const hits: SearchHit[] = views.map((v) => ({ ref: viewRef(v.id as string, v.revision as number), kind: 'view', title: v.name as string, snippet: String(v.notes ?? '').slice(0, 200), state: v.archived === true ? 'archived' : 'active' }));
    const notes = (await sql.query(`select * from ${S}.annotations where tenant_id=$1 and project_id=$2 and body ilike $3 order by created_at desc, id limit ${limit}`, [...sc(ctx), like(query.q)])).map(toAnnotation);
    for (const a of (await visibleOnly(ctx, notes, (n) => n.subject)).rows) hits.push({ ref: a.ref, kind: 'annotation', title: `${a.kind.replace('_', ' ')} on ${a.subject}`, snippet: a.body.slice(0, 200), state: a.status });
    return hits.slice(0, limit);
  }
  async function audit(ctx: ServiceContext, options: { after?: string; limit?: number; subject?: string } = {}): Promise<AuditRecord[]> {
    read(ctx);
    if (options.after !== undefined) invariant(/^\d{1,19}$/.test(options.after), 'invalid_input', 'after must be an audit record id');
    return listAudit(sql, S, ctx, options);
  }
  async function events(ctx: ServiceContext, options: { after?: string; limit?: number } = {}): Promise<EngineEvent[]> {
    requireCapability(ctx, 'workspace:events');
    return (await readEvents(sql, S, { ...options, tenantId: ctx.tenantId })).map((e) => ({ ...e, engine: ENGINE_ID }));
  }
  const CHANGE_KINDS = ['source_corrected', 'source_superseded', 'source_removed', 'permission_withdrawn', 'permission_changed', 'claim_changed', 'content_changed', 'render_changed', 'audience_changed', 'rights_changed'];
  /**
   * Flags saved views whose current revision pins a changed object. Nothing is deleted or rewritten: the flag stays until
   * an editor acknowledges it. Withdrawn permissions and removed sources flag the pin `blocked`, everything else `stale`.
   */
  async function applyUpstreamChange(ctx: ServiceContext, change: UpstreamChange): Promise<{ affected: string[] }> {
    requireCapability(ctx, 'workspace:events');
    invariant(change !== null && typeof change === 'object', 'invalid_input', 'Change required');
    const eventId = text(change.eventId, 'eventId', 200);
    invariant(CHANGE_KINDS.includes(change.kind), 'invalid_input', 'Unknown change kind');
    invariant(Array.isArray(change.refs) && change.refs.length <= 1000, 'invalid_input', 'refs must be a list of at most 1000 references');
    for (const r of change.refs) parseUref(r);
    const reason = String(change.reason ?? '').slice(0, 500);
    const effect = change.kind === 'permission_withdrawn' || change.kind === 'source_removed' ? 'blocked' : 'stale';
    return sql.tx(async (tx) => {
      const fresh = await tx.query(`insert into ${S}.upstream_changes (tenant_id, project_id, event_id, affected, applied_at) values ($1,$2,$3,'[]'::jsonb,$4) on conflict do nothing returning event_id`, [...sc(ctx), eventId, ctx.now]);
      if (fresh.length === 0) {
        const prior = (await tx.query<{ affected: string[] }>(`select affected from ${S}.upstream_changes where tenant_id=$1 and project_id=$2 and event_id=$3`, [...sc(ctx), eventId]))[0];
        return { affected: prior?.affected ?? [] };
      }
      const affected: string[] = [];
      if (change.refs.length > 0) {
        const keys = [...new Set(change.refs.map(subjectKey))];
        const views = await tx.query<{ id: string; revision: number; definition: Definition }>(`select v.id, v.revision, r.definition from ${S}.views v join ${S}.view_revisions r on r.tenant_id=v.tenant_id and r.project_id=v.project_id and r.view_id=v.id and r.revision=v.revision
          where v.tenant_id=$1 and v.project_id=$2 and not v.archived and exists (select 1 from jsonb_array_elements(r.definition->'pins') p where regexp_replace(p->>'ref', '@[0-9]+$', '') = any($3::text[])) order by v.id for update of v`, [...sc(ctx), keys]);
        for (const v of views) {
          const hits: { pin: string; cause: string }[] = [];
          for (const pin of v.definition.pins) { const cause = change.refs.find((r) => urefMatches(r, pin.ref)); if (cause !== undefined) hits.push({ pin: pin.ref, cause }); }
          if (hits.length === 0) continue;
          for (const h of hits) await tx.query(`insert into ${S}.view_flags (tenant_id, project_id, view_id, ref, effect, reason, change_kind, cause_event_id, cause_ref, flagged_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict do nothing`, [...sc(ctx), v.id, h.pin, effect, reason, change.kind, eventId, h.cause, ctx.now]);
          const subject = viewRef(v.id, v.revision);
          await appendAudit(tx, S, ctx, `view.${effect}`, viewRef(v.id), { cause: eventId, kind: change.kind, refs: hits.map((h) => h.pin) });
          await emitEvent(tx, S, ctx, `view.${effect}`, subject, { reason, cause: eventId, refs: hits.map((h) => h.pin) });
          affected.push(subject);
        }
      }
      await tx.query(`update ${S}.upstream_changes set affected=$4::jsonb where tenant_id=$1 and project_id=$2 and event_id=$3`, [...sc(ctx), eventId, JSON.stringify(affected)]);
      return { affected };
    });
  }
  async function health(): Promise<{ ok: boolean; detail: Json }> {
    try { await sql.query('select 1'); return { ok: true, detail: { database: 'ok', connectedEngines: Object.keys(deps.ports?.engines ?? {}).sort(), controlPorts: Object.keys(controlPorts).sort() } }; }
    catch { return { ok: false, detail: { database: 'unavailable' } }; }
  }

  const self: EnginePort = { manifest, inspect, search, audit, health };
  const aggregator = createAggregator(deps.ports?.engines ?? {}, self, config);

  async function inspectOne(ctx: ServiceContext, ref: string): Promise<ObjectView & { annotations: Annotation[] }> {
    const view = await aggregator.inspectOne(ctx, ref);
    return { ...view, annotations: await annotationsFor(ctx, ref) };
  }
  async function exportAudit(ctx: ServiceContext, query: AuditQuery & { format?: 'csv' | 'json'; includeDetail?: boolean } = {}): Promise<AuditExport> {
    read(ctx);
    requireCapability(ctx, 'workspace:export');
    const built = await aggregator.buildAuditExport(ctx, query);
    const id = randomUUID();
    const subject = query.subject ?? uref(ENGINE_ID, 'audit_export', id);
    await sql.tx(async (tx) => {
      await appendAudit(tx, S, ctx, 'audit.exported', subject, { export: id, format: built.format, recordCount: built.recordCount, sha256: built.sha256, truncated: built.truncated, includeDetail: query.includeDetail === true, engines: built.engines.map((e) => ({ engine: e.engine, status: e.status })) });
      await emitEvent(tx, S, ctx, 'audit.exported', subject, { export: id, format: built.format, recordCount: built.recordCount });
    });
    return { id, ...built, filename: `audit-${ctx.now.slice(0, 10)}-${id.slice(0, 8)}.${built.format}` };
  }
  async function listEngines(ctx: ServiceContext): Promise<{ engine: string; name: string; version: string; emits: string[]; controls: boolean }[]> {
    read(ctx);
    return aggregator.known().map((id) => {
      const m = (aggregator.port(id) as EnginePort).manifest;
      return { engine: id, name: String(m?.name ?? id), version: String(m?.version ?? ''), emits: Array.isArray(m?.emits) ? [...m.emits] : [], controls: id === ENGINE_ID || Object.hasOwn(controlPorts, id) || Object.hasOwn(controlPorts, '*') };
    });
  }

  // ── Controls ──
  function toInvocation(r: Record<string, unknown>): ControlInvocation {
    return { id: r.id as string, ref: uref(ENGINE_ID, 'control_invocation', r.id as string), subject: r.subject as string, controlId: r.control_id as string, source: r.source as string, capability: r.capability as string, dangerous: r.dangerous as boolean,
      outcome: r.outcome as ControlOutcome, result: (r.result as Json | undefined) ?? null, error: r.error_code === null || r.error_code === undefined ? null : { code: r.error_code as string, message: String(r.error_message ?? '') },
      actorId: r.actor_id as string, requestId: r.request_id as string, startedAt: iso(r.started_at), finishedAt: isoOrNull(r.finished_at) };
  }
  const portsFor = (engine: string): [string, ControlPort][] => [engine, '*'].filter((k) => Object.hasOwn(controlPorts, k)).map((k) => [k === '*' ? 'host' : k, controlPorts[k] as ControlPort]);
  async function collectControls(ctx: ServiceContext, ref: string): Promise<{ controls: (ControlSpec & { source: string })[]; unavailable: boolean; ports: Map<string, ControlPort> }> {
    const engine = parseUref(ref).engine;
    const controls: (ControlSpec & { source: string })[] = [];
    const used = new Map<string, ControlPort>();
    let unavailable = false;
    for (const [source, p] of portsFor(engine)) {
      const out = await callPort(() => p.controlsFor(ctx, ref), config.engineTimeoutMs);
      if (out.status === 'unavailable') { unavailable = true; continue; }
      if (out.status !== 'ok' || !Array.isArray(out.value)) continue;
      for (const spec of out.value) {
        if (!validSpec(spec) || used.has(spec.id)) continue;
        used.set(spec.id, p);
        controls.push({ id: spec.id, label: spec.label, capability: spec.capability, dangerous: spec.dangerous, input: (spec.input ?? { type: 'object', properties: {} }) as Json, ...(typeof spec.description === 'string' ? { description: spec.description.slice(0, 1000) } : {}), source });
      }
    }
    for (const spec of BUILTIN_CONTROLS) controls.push({ ...spec, source: ENGINE_ID });
    return { controls, unavailable, ports: used };
  }
  async function listControls(ctx: ServiceContext, ref: string): Promise<ControlList> {
    read(ctx);
    parseUref(ref);
    const seen = await aggregator.visibility(ctx, ref);
    if (seen === 'hidden') notFound();
    const found = await collectControls(ctx, ref);
    // Workspace notes need the object to be confirmed visible; while its engine is unreachable only host controls are listed.
    const usable = seen === 'visible' ? found.controls : found.controls.filter((c) => c.source !== ENGINE_ID);
    return {
      ref, unavailable: found.unavailable || seen === 'unavailable', generatedAt: ctx.now,
      controls: usable.map((c) => {
        const missing = [c.capability, 'workspace:control'].filter((cap) => !hasCapability(ctx, cap));
        return { ...c, allowed: missing.length === 0, ...(missing.length === 0 ? {} : { deniedReason: `Requires ${missing.join(' and ')}` }) };
      }),
    };
  }
  async function builtin(ctx: ServiceContext, ref: string, controlId: string, input: Record<string, Json>, invocationId: string): Promise<Json> {
    if (controlId === 'workspace.export_audit') {
      const out = await exportAudit(ctx, { subject: ref, format: input.format === 'json' ? 'json' : 'csv' });
      return out as unknown as Json;
    }
    const note = await annotate(ctx, { ref, kind: controlId === 'workspace.review_note' ? 'review' : 'correction_request', body: String(input.body ?? ''), idempotencyKey: `control:${invocationId}` });
    return note as unknown as Json;
  }
  async function invokeControl(ctx: ServiceContext, ref: string, controlId: string, input: Json = {}, options: { confirm?: boolean; idempotencyKey?: string } = {}): Promise<ControlInvocation> {
    requireCapability(ctx, 'workspace:control');
    parseUref(ref);
    invariant(typeof controlId === 'string' && controlId.length <= 100, 'invalid_input', 'controlId required');
    const payload = jsonValue(input ?? {}, 'input', 65_536);
    const key = options.idempotencyKey;
    if (key !== undefined) invariant(typeof key === 'string' && key.length > 0 && key.length <= 200, 'invalid_input', 'Invalid idempotency key');
    const inputDigest = createHash('sha256').update(JSON.stringify([ref, controlId, payload])).digest('hex');
    if (key !== undefined) {
      const prior = (await sql.query(`select * from ${S}.control_invocations where tenant_id=$1 and project_id=$2 and idempotency_key=$3`, [...sc(ctx), key]))[0];
      if (prior !== undefined) {
        invariant(prior.input_digest === inputDigest && prior.actor_id === ctx.actor.id, 'idempotency_conflict', 'Idempotency key was used with different input');
        // An attempt whose outcome was never recorded may or may not have taken effect; it is not repeated blindly.
        invariant(prior.outcome !== 'attempted', 'idempotency_conflict', 'The original request did not complete; its outcome is unknown');
        return toInvocation(prior);
      }
    }
    if (await aggregator.visibility(ctx, ref) === 'hidden') notFound();
    const found = await collectControls(ctx, ref);
    const spec = found.controls.find((c) => c.id === controlId);
    if (spec === undefined) {
      if (found.unavailable) throw new DomainError('unavailable', 'The controls for this object are currently unavailable');
      return notFound();
    }
    const id = randomUUID();
    const base = [...sc(ctx), id, ref, controlId, spec.source, spec.capability, spec.dangerous, inputDigest, key ?? null];
    const record = async (outcome: ControlOutcome, at: string, result: Json, error: { code: string; message: string } | null, insert: boolean): Promise<ControlInvocation> => sql.tx(async (tx) => {
      const encoded = JSON.stringify(result ?? null);
      const stored = encoded.length <= 65_536 ? encoded : JSON.stringify({ omitted: 'result larger than 64 KiB was returned to the caller but not stored' });
      const row = insert
        ? (await tx.query(`insert into ${S}.control_invocations (tenant_id, project_id, id, subject, control_id, source, capability, dangerous, input_digest, idempotency_key, outcome, result, error_code, error_message, actor_id, request_id, started_at, finished_at)
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18) returning *`, [...base, outcome, stored, error?.code ?? null, error?.message.slice(0, 1000) ?? null, ctx.actor.id, ctx.requestId, ctx.now, outcome === 'attempted' ? null : at]))[0]
        : (await tx.query(`update ${S}.control_invocations set outcome=$4, result=$5::jsonb, error_code=$6, error_message=$7, finished_at=$8 where tenant_id=$1 and project_id=$2 and id=$3 returning *`, [...sc(ctx), id, outcome, stored, error?.code ?? null, error?.message.slice(0, 1000) ?? null, at]))[0];
      // Inputs and results can carry content, so the audit trail holds the digest and the outcome only.
      await appendAudit(tx, S, { ...ctx, now: at }, `control.${outcome}`, ref, { invocation: id, controlId, source: spec.source, capability: spec.capability, dangerous: spec.dangerous, inputDigest, ...(error === null ? {} : { error: error.code }) });
      if (outcome === 'succeeded' || outcome === 'failed' || outcome === 'uncertain') await emitEvent(tx, S, { ...ctx, now: at }, `control.${outcome}`, ref, { invocation: id, controlId });
      return toInvocation(row as Record<string, unknown>);
    });
    if (!hasCapability(ctx, spec.capability)) {
      await record('denied', ctx.now, null, { code: 'forbidden', message: `Missing capability ${spec.capability}` }, true);
      throw new DomainError('forbidden', `Missing capability ${spec.capability}`);
    }
    if (spec.dangerous && options.confirm !== true) throw new DomainError('confirmation_required', `"${spec.label}" needs explicit confirmation`);
    validateControlInput(spec.input, payload);
    await record('attempted', ctx.now, null, null, true);
    try {
      const result = spec.source === ENGINE_ID
        ? await builtin(ctx, ref, controlId, payload as Record<string, Json>, id)
        : await withTimeout(Promise.resolve().then(() => (found.ports.get(controlId) as ControlPort).invoke(ctx, ref, controlId, payload)), controlTimeoutMs);
      return await record('succeeded', new Date().toISOString(), JSON.parse(JSON.stringify(result ?? null)) as Json, null, false);
    } catch (error) {
      if (isDomainError(error)) {
        await record('failed', new Date().toISOString(), null, { code: error.code, message: error.message }, false);
        throw new ControlError(error.code, error.message, id);
      }
      // A timeout or transport failure leaves the real outcome unknown: it is recorded as such, never as a failure.
      const timedOut = error instanceof Error && error.message === 'timeout';
      await record('uncertain', new Date().toISOString(), null, { code: timedOut ? 'timeout' : 'control_error', message: timedOut ? 'The control did not answer in time; whether it took effect is unknown' : 'The control failed without a reported reason; whether it took effect is unknown' }, false);
      throw new ControlError('control_uncertain', timedOut ? 'The control did not answer in time; whether it took effect is unknown' : 'The control failed without a reported reason; whether it took effect is unknown', id);
    }
  }
  async function listControlInvocations(ctx: ServiceContext, options: { ref?: string; limit?: number } = {}): Promise<ControlInvocation[]> {
    read(ctx);
    const limit = Math.min(Math.max(Number.isInteger(options.limit) ? options.limit as number : 50, 1), 200);
    if (options.ref !== undefined) await requireVisible(ctx, options.ref);
    const rows = (await sql.query(`select * from ${S}.control_invocations where tenant_id=$1 and project_id=$2 and ($3::text is null or subject=$3) order by started_at desc, id limit ${limit}`, [...sc(ctx), options.ref ?? null])).map(toInvocation);
    return options.ref !== undefined ? rows : (await visibleOnly(ctx, rows, (r) => r.subject)).rows;
  }

  return {
    manifest, inspect, search, audit, events, applyUpstreamChange, health,
    inspectLinked: aggregator.inspectLinked, inspectOne, searchAll: aggregator.searchAll, auditTimeline: aggregator.auditTimeline, exportAudit, overview: aggregator.overview, listEngines,
    createView, updateView, archiveView, getView, listViews, listViewRevisions, resolveView, acknowledgeViewFlags,
    annotate, resolveAnnotation, listAnnotations, listControls, invokeControl, listControlInvocations,
  };
}

/** A control that the owning engine refused or that failed; carries the engine's own code and the recorded invocation. */
export class ControlError extends DomainError {
  readonly invocationId: string;
  constructor(code: string, message: string, invocationId: string) { super(code, message); this.invocationId = invocationId; }
}

// ───────────────────────────── HTTP ─────────────────────────────
const OWN_STATUS: Readonly<Record<string, number>> = { confirmation_required: 409, control_uncertain: 504, unavailable: 503, provider_unavailable: 503 };
/**
 * The kit HTTP layer answers 500 for 5xx and unmapped error codes and only recognises its own DomainError class.
 * Routes therefore translate errors themselves: `unavailable` is a real 503, a control refused by its engine keeps the
 * engine's code and message, and DomainErrors thrown by another engine's copy of the class are re-thrown as ours.
 */
function guarded(handler: Route['handler']): Route['handler'] {
  return async (request: HttpRequest) => {
    try { return await handler(request); }
    catch (error) {
      if (!isDomainError(error)) throw error;
      const requestId = request.ctx?.requestId ?? '';
      const invocationId = error instanceof ControlError ? error.invocationId : undefined;
      const known = OWN_STATUS[error.code] ?? errorStatus(error.code);
      const status = known >= 500 && invocationId !== undefined && OWN_STATUS[error.code] === undefined ? 409 : known;
      if (status === 404) throw new DomainError('not_found', 'Not found');
      if (status === 500) throw error;
      return { status, json: { error: { code: error.code, message: error.message, requestId, ...(invocationId === undefined ? {} : { invocationId }) } } } satisfies HttpResponse;
    }
  };
}
const obj = (body: unknown): Record<string, unknown> => { invariant(body !== null && typeof body === 'object' && !Array.isArray(body), 'invalid_input', 'JSON object body required'); return body as Record<string, unknown>; };
const qInt = (q: URLSearchParams, name: string): number | undefined => { const v = q.get(name); if (v === null || v === '') return undefined; invariant(/^\d{1,6}$/.test(v), 'invalid_input', `${name} must be a non-negative integer`); return Number(v); };
const qList = (q: URLSearchParams, name: string): string[] | undefined => { const v = q.get(name); return v === null || v === '' ? undefined : v.split(',').map((s) => s.trim()).filter((s) => s !== ''); };
function auditQuery(q: URLSearchParams): AuditQuery & { format?: 'csv' | 'json'; includeDetail?: boolean } {
  const subject = q.get('subject'), after = q.get('after'), order = q.get('order'), engines = qList(q, 'engines'), limit = qInt(q, 'limit'), format = q.get('format');
  const cursors: Record<string, string> = {};
  for (const part of qList(q, 'cursors') ?? []) { const [k, v] = part.split(':'); invariant(k !== undefined && v !== undefined, 'invalid_input', 'cursors must look like E05:12,E07:3'); cursors[k] = v; }
  return {
    ...(subject === null || subject === '' ? {} : { subject }), ...(after === null || after === '' ? {} : { after }), ...(engines === undefined ? {} : { engines }), ...(limit === undefined ? {} : { limit }),
    ...(order === null ? {} : { order: order as 'asc' | 'desc' }), ...(Object.keys(cursors).length === 0 ? {} : { cursors }), ...(q.get('verify') === '0' ? { verifyChains: false } : {}),
    ...(format === null ? {} : { format: format as 'csv' | 'json' }), ...(q.get('detail') === '1' ? { includeDetail: true } : {}),
  };
}

export function routes(engine: WorkspaceEngine): Route[] {
  const json = (value: unknown): Json => value as Json;
  const linked: Route['handler'] = async (r) => {
    const depth = qInt(r.query, 'depth'), maxNodes = qInt(r.query, 'maxNodes'), direction = r.query.get('direction');
    const view = await engine.inspectLinked(r.ctx, r.query.get('ref') ?? '', { ...(depth === undefined ? {} : { depth }), ...(maxNodes === undefined ? {} : { maxNodes }), ...(direction === null ? {} : { direction: direction as 'both' }) });
    const format = r.query.get('format') ?? 'json';
    invariant(['json', 'text', 'table'].includes(format), 'invalid_input', 'format must be json, text or table');
    if (format === 'text') return { text: `${view.outline.text}\n` };
    return json(format === 'table' ? view.table : view);
  };
  const object: Route['handler'] = async (r) => json(await engine.inspectOne(r.ctx, r.query.get('ref') ?? ''));
  const searchAll: Route['handler'] = async (r) => { const engines = qList(r.query, 'engines'), limit = qInt(r.query, 'limit'); return json(await engine.searchAll(r.ctx, { q: r.query.get('q') ?? '', ...(engines === undefined ? {} : { engines }), ...(limit === undefined ? {} : { limit }) })); };
  const timeline: Route['handler'] = async (r) => json(await engine.auditTimeline(r.ctx, auditQuery(r.query)));
  const overview: Route['handler'] = async (r) => json(await engine.overview(r.ctx));
  const exportNow = async (ctx: ServiceContext, query: AuditQuery & { format?: 'csv' | 'json'; includeDetail?: boolean }, download: boolean): Promise<HttpResponse | Json> => {
    const out = await engine.exportAudit(ctx, query);
    if (!download) return json(out);
    return { bytes: new TextEncoder().encode(out.content), headers: { 'content-type': out.mediaType, 'content-disposition': `attachment; filename="${out.filename}"`, 'x-export-id': out.id, 'x-export-sha256': out.sha256, 'x-export-records': String(out.recordCount), 'x-export-truncated': String(out.truncated) } };
  };
  const named: Readonly<Record<string, Route['handler']>> = { overview, linked, object, search: searchAll, audit: timeline };
  const own: Route[] = [
    // Read models (catalog: GET /v1/views/{view}); the short paths below are equivalent.
    { method: 'GET', path: '/v1/views/:view', handler: async (r) => { const h = Object.hasOwn(named, r.params.view ?? '') ? named[r.params.view as string] : undefined; if (h === undefined) throw new DomainError('not_found', 'Not found'); return h(r); } },
    { method: 'GET', path: '/v1/overview', handler: overview },
    { method: 'GET', path: '/v1/linked', handler: linked },
    { method: 'GET', path: '/v1/objects', handler: object },
    { method: 'GET', path: '/v1/search-all', handler: searchAll },
    { method: 'GET', path: '/v1/audit-timeline', handler: timeline },
    { method: 'GET', path: '/v1/audit-timeline/export', handler: (r) => exportNow(r.ctx, auditQuery(r.query), true) },
    { method: 'POST', path: '/v1/audit-exports', handler: (r) => exportNow(r.ctx, obj(r.body ?? {}) as AuditQuery, false) },
    { method: 'GET', path: '/v1/audit/resources/:ref', handler: async (r) => json(await engine.auditTimeline(r.ctx, { ...auditQuery(r.query), subject: r.params.ref ?? '' })) },
    { method: 'GET', path: '/v1/streams', handler: async (r) => json(await engine.listEngines(r.ctx)) },
    // Saved views
    { method: 'POST', path: '/v1/saved-views', handler: async (r) => ({ status: 201, json: await engine.createView(r.ctx, obj(r.body) as unknown as ViewInput) }) },
    { method: 'GET', path: '/v1/saved-views', handler: async (r) => { const limit = qInt(r.query, 'limit'); return json(await engine.listViews(r.ctx, { includeArchived: r.query.get('archived') === '1', ...(limit === undefined ? {} : { limit }) })); } },
    { method: 'GET', path: '/v1/saved-views/:id', handler: async (r) => { const revision = qInt(r.query, 'revision'); return json(await engine.getView(r.ctx, r.params.id ?? '', revision === undefined ? {} : { revision })); } },
    { method: 'PATCH', path: '/v1/saved-views/:id', handler: async (r) => json(await engine.updateView(r.ctx, r.params.id ?? '', obj(r.body) as unknown as { expectedRevision: number })) },
    { method: 'GET', path: '/v1/saved-views/:id/revisions', handler: async (r) => json(await engine.listViewRevisions(r.ctx, r.params.id ?? '')) },
    { method: 'GET', path: '/v1/saved-views/:id/board', handler: async (r) => json(await engine.resolveView(r.ctx, r.params.id ?? '')) },
    { method: 'POST', path: '/v1/saved-views/:id/archive', handler: async (r) => json(await engine.archiveView(r.ctx, r.params.id ?? '', obj(r.body) as unknown as { expectedRevision: number })) },
    { method: 'POST', path: '/v1/saved-views/:id/acknowledge', handler: async (r) => json(await engine.acknowledgeViewFlags(r.ctx, r.params.id ?? '', obj(r.body ?? {}))) },
    // Annotations
    { method: 'POST', path: '/v1/annotations', handler: async (r) => ({ status: 201, json: await engine.annotate(r.ctx, obj(r.body) as unknown as { ref: string; body: string }) }) },
    { method: 'GET', path: '/v1/annotations', handler: async (r) => { const ref = r.query.get('ref'), status = r.query.get('status'), limit = qInt(r.query, 'limit'); return json(await engine.listAnnotations(r.ctx, { ...(ref === null ? {} : { ref }), ...(status === null ? {} : { status: status as 'open' }), ...(limit === undefined ? {} : { limit }) })); } },
    { method: 'POST', path: '/v1/annotations/:id/resolve', handler: async (r) => json(await engine.resolveAnnotation(r.ctx, r.params.id ?? '', obj(r.body ?? {}))) },
    // Controls
    { method: 'GET', path: '/v1/controls', handler: async (r) => json(await engine.listControls(r.ctx, r.query.get('ref') ?? '')) },
    { method: 'POST', path: '/v1/controls/invoke', handler: async (r) => {
      const b = obj(r.body);
      invariant(typeof b.ref === 'string' && typeof b.controlId === 'string', 'invalid_input', 'ref and controlId are required');
      return json(await engine.invokeControl(r.ctx, b.ref, b.controlId, (b.input ?? {}) as Json, { confirm: b.confirm === true, ...(typeof b.idempotencyKey === 'string' ? { idempotencyKey: b.idempotencyKey } : {}) }));
    } },
    { method: 'GET', path: '/v1/control-invocations', handler: async (r) => { const ref = r.query.get('ref'), limit = qInt(r.query, 'limit'); return json(await engine.listControlInvocations(r.ctx, { ...(ref === null ? {} : { ref }), ...(limit === undefined ? {} : { limit }) })); } },
  ];
  return [...standardRoutes(engine), ...own].map((route) => ({ ...route, handler: guarded(route.handler) }));
}

export { ENGINE_ID, isDomainError } from './aggregate.ts';
