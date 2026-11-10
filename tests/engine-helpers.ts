// Small REAL engines for E14 tests: each owns a PostgreSQL schema, enforces its own capabilities and compartments and
// implements the kit StandardEngine surface. They stand in for E00…E13 so that E14 is exercised against real ports.
import { DomainError, invariant } from '../src/contracts.ts';
import type { Json } from '../src/contracts.ts';
import * as kit from '../src/service-kit.ts';
import type { ControlPort, ControlSpec, EnginePort } from '../src/engine/index.ts';

export const ADMIN = process.env.TEST_DATABASE_URL ?? '';
export const needsPg = ADMIN === '' ? { skip: 'TEST_DATABASE_URL is not set; real-PostgreSQL test not executed' } : {};

export type Thing = { id: string; kind: string; title: string; state?: string; sources?: string[]; dependents?: string[]; stale?: boolean; blocked?: boolean; staleReasons?: string[]; compartment?: string | null };
export type MiniEngine = kit.StandardEngine & {
  id: string; short: string; schema: string; calls: { method: string; actorId: string; tenantId: string; capabilities: readonly string[] }[];
  put(ctx: kit.ServiceContext, thing: Thing): Promise<string>;
  setState(ctx: kit.ServiceContext, id: string, from: readonly string[], to: string, action: string): Promise<Json>;
};

export async function miniEngine(sql: kit.Sql, id: string, short: string): Promise<MiniEngine> {
  const schema = `${id.toLowerCase()}_${short}`;
  await kit.runMigrations(sql, schema, [{ id: '001', sql: `create table {s}.things (
    tenant_id text not null, project_id text not null, id text not null, kind text not null, title text not null, state text not null, revision int not null default 1,
    sources text[] not null, dependents text[] not null, stale boolean not null, blocked boolean not null, stale_reasons text[] not null, compartment text,
    actor_id text not null, at timestamptz not null, primary key (tenant_id, project_id, kind, id))` }]);
  const calls: MiniEngine['calls'] = [];
  const note = (method: string, ctx: kit.ServiceContext): void => { calls.push({ method, actorId: ctx.actor.id, tenantId: ctx.tenantId, capabilities: ctx.capabilities }); };
  const manifest: kit.EngineManifestV1 = { id, name: `Test ${short}`, version: '0.0.1', kit: kit.SERVICE_KIT_VERSION, capabilities: [`${short}:read`, `${short}:write`, `${short}:events`], emits: ['thing.saved', 'thing.stale'], consumes: [] };
  const refOf = (r: kit.Row): string => kit.uref(id, r.kind as string, r.id as string, r.revision as number);
  return {
    id, short, schema, calls, manifest,
    async put(ctx, thing) {
      kit.requireCapability(ctx, `${short}:write`);
      return sql.tx(async (tx) => {
        const row = (await tx.query(`insert into ${schema}.things (tenant_id, project_id, id, kind, title, state, sources, dependents, stale, blocked, stale_reasons, compartment, actor_id, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          on conflict (tenant_id, project_id, kind, id) do update set title=excluded.title, state=excluded.state, sources=excluded.sources, dependents=excluded.dependents, stale=excluded.stale, blocked=excluded.blocked, stale_reasons=excluded.stale_reasons, revision=${schema}.things.revision+1 returning *`,
          [ctx.tenantId, ctx.projectId, thing.id, thing.kind, thing.title, thing.state ?? 'active', thing.sources ?? [], thing.dependents ?? [], thing.stale ?? false, thing.blocked ?? false, thing.staleReasons ?? [], thing.compartment ?? null, ctx.actor.id, ctx.now]))[0] as kit.Row;
        await kit.appendAudit(tx, schema, ctx, 'thing.saved', kit.uref(id, thing.kind, thing.id), { revision: row.revision as number });
        await kit.emitEvent(tx, schema, ctx, 'thing.saved', refOf(row), {});
        return refOf(row);
      });
    },
    async setState(ctx, thingId, from, to, action) {
      note(action, ctx);
      kit.requireCapability(ctx, `${short}:write`);
      return sql.tx(async (tx) => {
        const row = (await tx.query(`select * from ${schema}.things where tenant_id=$1 and project_id=$2 and id=$3 for update`, [ctx.tenantId, ctx.projectId, thingId]))[0];
        if (row === undefined || (row.compartment !== null && !ctx.compartments.includes(row.compartment as string))) throw new DomainError('not_found', 'Not found');
        if (!from.includes(row.state as string)) throw new DomainError('invalid_state', `Task in state ${row.state as string} cannot ${action}`);
        await tx.query(`update ${schema}.things set state=$4 where tenant_id=$1 and project_id=$2 and id=$3`, [ctx.tenantId, ctx.projectId, thingId, to]);
        await kit.appendAudit(tx, schema, ctx, `thing.${action}`, kit.uref(id, row.kind as string, thingId), { from: row.state as string, to });
        return { id: thingId, state: to };
      });
    },
    async inspect(ctx, ref) {
      note('inspect', ctx);
      kit.requireCapability(ctx, `${short}:read`);
      const p = kit.parseUref(ref);
      if (p.engine !== id) return null;
      const row = (await sql.query(`select * from ${schema}.things where tenant_id=$1 and project_id=$2 and kind=$3 and id=$4`, [ctx.tenantId, ctx.projectId, p.kind, p.id]))[0];
      if (row === undefined || (row.compartment !== null && !ctx.compartments.includes(row.compartment as string))) return null;
      const history = (await kit.listAudit(sql, schema, ctx, { subject: kit.uref(id, p.kind, p.id) })).map((a) => ({ at: a.at, actorId: a.actorId, action: a.action, detail: a.detail }));
      return {
        ref: refOf(row), kind: row.kind as string, title: row.title as string, state: row.state as string, stale: row.stale as boolean, blocked: row.blocked as boolean, staleReasons: row.stale_reasons as string[],
        versions: Array.from({ length: row.revision as number }, (_, i) => ({ revision: i + 1, at: new Date(row.at as Date).toISOString(), actorId: row.actor_id as string })),
        sources: row.sources as string[], dependents: row.dependents as string[], permissions: row.blocked === true ? [{ decision: 'deny', reason: 'permission withdrawn' }] : [], decisions: row.stale === true ? [{ type: 'review_required' }] : [],
        history, data: { compartment: row.compartment as string | null },
      };
    },
    async search(ctx, query) {
      note('search', ctx);
      kit.requireCapability(ctx, `${short}:read`);
      const rows = await sql.query(`select * from ${schema}.things where tenant_id=$1 and project_id=$2 and title ilike $3 and (compartment is null or compartment = any($4::text[])) order by id limit $5`, [ctx.tenantId, ctx.projectId, `%${query.q}%`, [...ctx.compartments], query.limit ?? 20]);
      return rows.map((r) => ({ ref: refOf(r), kind: r.kind as string, title: r.title as string, snippet: r.title as string, state: r.state as string }));
    },
    async audit(ctx, options = {}) { note('audit', ctx); kit.requireCapability(ctx, `${short}:read`); return kit.listAudit(sql, schema, ctx, options); },
    async events(ctx, options = {}) { kit.requireCapability(ctx, `${short}:events`); return kit.readEvents(sql, schema, { ...options, tenantId: ctx.tenantId }); },
    async applyUpstreamChange(ctx, change) {
      kit.requireCapability(ctx, `${short}:events`);
      return sql.tx(async (tx) => {
        const rows = await tx.query(`select * from ${schema}.things where tenant_id=$1 and project_id=$2 for update`, [ctx.tenantId, ctx.projectId]);
        const affected: string[] = [];
        for (const r of rows) {
          if (!(r.sources as string[]).some((s) => change.refs.some((c) => kit.urefMatches(c, s)))) continue;
          await tx.query(`update ${schema}.things set stale=true, stale_reasons=array_append(stale_reasons, $5) where tenant_id=$1 and project_id=$2 and kind=$3 and id=$4`, [ctx.tenantId, ctx.projectId, r.kind, r.id, change.reason]);
          await kit.emitEvent(tx, schema, ctx, 'thing.stale', refOf(r), { reason: change.reason, cause: change.eventId });
          affected.push(refOf(r));
        }
        return { affected };
      });
    },
    async health() { return { ok: true, detail: { counts: { things: Number(((await sql.query(`select count(*)::int as n from ${schema}.things`))[0] as kit.Row).n) } } }; },
  };
}

/** An engine that is down: inspect throws a plain error, search never answers, audit reports `unavailable`. */
export function brokenEngine(id: string): EnginePort {
  return {
    manifest: { id, name: 'Test broken engine', version: '0.0.1', kit: kit.SERVICE_KIT_VERSION, capabilities: [], emits: [], consumes: [] },
    inspect: async () => { throw new Error('connection refused: internal detail that must not leak'); },
    search: () => new Promise(() => { /* never answers */ }),
    audit: async () => { throw new DomainError('unavailable', 'database down'); },
    health: async () => { throw new Error('down'); },
  };
}

export const ALL_CAPS = ['workspace:read', 'workspace:write', 'workspace:control', 'workspace:export', 'workspace:events',
  'orchestration:read', 'orchestration:write', 'orchestration:events', 'evidence:read', 'evidence:write', 'evidence:events', 'knowledge:read', 'knowledge:write', 'knowledge:events',
  'investigation:read', 'investigation:write', 'investigation:events', 'editorial:read', 'editorial:write', 'editorial:events'];
let request = 0;
export const ctxOf = (over: Partial<kit.ServiceContext> = {}): kit.ServiceContext => ({
  tenantId: 't1', projectId: 'p1', purpose: 'test', requestId: `req-${++request}`, now: new Date(Date.UTC(2026, 0, 1) + request * 1000).toISOString(),
  actor: { id: 'ana', kind: 'human', roles: ['editor'] }, capabilities: ALL_CAPS, compartments: ['sealed'], ...over,
});

export type World = { sql: kit.Sql; url: string; e00: MiniEngine; e05: MiniEngine; e07: MiniEngine; e08: MiniEngine; e09: MiniEngine; engines: Record<string, EnginePort>; taskControls: ControlPort & { invoked: { controlId: string; actorId: string; input: Json }[]; hang: boolean } };

/**
 * Fictional project graph (upstream → downstream):
 *   E05 ev1, E05 ev2 (sealed compartment) → E07 claim c1 → E08 finding f1 → E09 scene s1 (blocked) and E00 task t1 (running)
 *   E06 derivative d1 (engine down) → f1;  E11 permission p1 (engine not connected) → s1;  E00 t1 → E00 t2 (queued);  E00 t3 failed
 *   E07 claim c2 is stale; E07 cyA ⇄ cyB form a cycle.
 */
export async function buildWorld(sql: kit.Sql, url: string): Promise<World> {
  const [e00, e05, e07, e08, e09] = await Promise.all([miniEngine(sql, 'E00', 'orchestration'), miniEngine(sql, 'E05', 'evidence'), miniEngine(sql, 'E07', 'knowledge'), miniEngine(sql, 'E08', 'investigation'), miniEngine(sql, 'E09', 'editorial')]);
  const c = (): kit.ServiceContext => ctxOf({ actor: { id: 'seed', kind: 'service', roles: [] } });
  await e05.put(c(), { id: 'ev1', kind: 'evidence', title: 'Harbour ledger scan' });
  await e05.put(c(), { id: 'ev2', kind: 'evidence', title: 'Sealed witness statement', compartment: 'sealed' });
  await e07.put(c(), { id: 'c1', kind: 'claim', title: 'Ledger shows a transfer', sources: ['E05:evidence:ev1@1', 'E05:evidence:ev2'], dependents: ['E08:finding:f1'] });
  await e07.put(c(), { id: 'c2', kind: 'claim', title: 'Transfer date claim', sources: ['E05:evidence:ev1'], stale: true, staleReasons: ['source corrected'] });
  await e07.put(c(), { id: 'cyA', kind: 'claim', title: 'Cycle A', sources: ['E07:claim:cyB'], dependents: ['E07:claim:cyB'] });
  await e07.put(c(), { id: 'cyB', kind: 'claim', title: 'Cycle B', sources: ['E07:claim:cyA'], dependents: ['E07:claim:cyA'] });
  await e08.put(c(), { id: 'f1', kind: 'finding', title: 'Finding on the transfer', sources: ['E07:claim:c1', 'E06:derivative:d1'], dependents: ['E09:scene:s1', 'E00:task:t1'] });
  await e09.put(c(), { id: 's1', kind: 'scene', title: 'Scene one', sources: ['E08:finding:f1', 'E11:permission:p1'], blocked: true, staleReasons: ['permission withdrawn'] });
  await e00.put(c(), { id: 't1', kind: 'task', title: 'Draft scene one', state: 'running', sources: ['E08:finding:f1'], dependents: ['E00:task:t2'] });
  await e00.put(c(), { id: 't2', kind: 'task', title: 'Review scene one', state: 'queued', sources: ['E00:task:t1'] });
  await e00.put(c(), { id: 't3', kind: 'task', title: 'Render preview', state: 'failed' });
  // Another tenant and another project have their own data in the same engines.
  await e05.put(ctxOf({ tenantId: 't2', actor: { id: 'seed', kind: 'service', roles: [] } }), { id: 'ev1', kind: 'evidence', title: 'Other tenant ledger' });
  await e05.put(ctxOf({ projectId: 'p2', actor: { id: 'seed', kind: 'service', roles: [] } }), { id: 'evp2', kind: 'evidence', title: 'Other project ledger' });

  const specs: ControlSpec[] = [
    { id: 'task.pause', label: 'Pause', capability: 'orchestration:write', dangerous: false, input: { type: 'object', properties: {} } },
    { id: 'task.resume', label: 'Resume', capability: 'orchestration:write', dangerous: false, input: { type: 'object', properties: {} } },
    { id: 'task.cancel', label: 'Cancel', capability: 'orchestration:write', dangerous: true, input: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', maxLength: 200 } } } },
    { id: 'task.reassign', label: 'Reassign', capability: 'orchestration:admin', dangerous: false, input: { type: 'object', required: ['assignee'], properties: { assignee: { type: 'string' } } } },
  ];
  const taskControls: World['taskControls'] = {
    invoked: [], hang: false,
    async controlsFor(ctx, ref) { const p = kit.parseUref(ref); return p.kind === 'task' && await e00.inspect(ctx, ref) !== null ? specs : []; },
    async invoke(ctx, ref, controlId, input) {
      taskControls.invoked.push({ controlId, actorId: ctx.actor.id, input });
      if (taskControls.hang) return new Promise<Json>(() => { /* never answers */ });
      const taskId = kit.parseUref(ref).id;
      if (controlId === 'task.pause') return e00.setState(ctx, taskId, ['running', 'queued'], 'paused', 'pause');
      if (controlId === 'task.resume') return e00.setState(ctx, taskId, ['paused'], 'queued', 'resume');
      if (controlId === 'task.cancel') return e00.setState(ctx, taskId, ['running', 'queued', 'paused'], 'cancelled', 'cancel');
      invariant(false, 'not_found', 'Not found');
    },
  };
  return { sql, url, e00, e05, e07, e08, e09, engines: { E00: e00, E05: e05, E06: brokenEngine('E06'), E07: e07, E08: e08, E09: e09 }, taskControls };
}

export const code = (expected: string) => (e: unknown): boolean => e instanceof Error && (e as { code?: string }).code === expected;
export async function poll<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (ok(v) || Date.now() > end) return v; await new Promise((r) => setTimeout(r, 100)); }
}
