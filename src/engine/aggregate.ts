// Cross-engine read models. E14 owns no domain facts: everything here is fetched through the registered engine
// ports with the CALLER's context, so each engine enforces its own authorization. Nothing is cached across callers.
import { createHash } from 'node:crypto';
import { DomainError, canonical, invariant } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { parseUref, requireCapability, urefMatches, verifyAuditChain } from '../service-kit.ts';
import type { AuditRecord, Inspection, SearchHit, ServiceContext, StandardEngine } from '../service-kit.ts';
import { STATE_DESCRIPTIONS, auditCsv, compareAudit, deriveState, nodeTable, parseRef, relationTable, stateLabel, textOutline } from '../../web/model.js';
import type { DisplayState, Graph, GraphEdge, GraphNode, Outline, TableModel } from '../../web/model.js';

export const ENGINE_ID = 'E14';
/** The subset of the kit `StandardEngine` that E14 reads. The host passes the real engines. */
export type EnginePort = Pick<StandardEngine, 'manifest' | 'inspect' | 'search' | 'audit' | 'health'>;
export type EngineRegistry = Readonly<Record<string, EnginePort>>;

export type AggregateConfig = Readonly<{
  /** Per-call timeout for an engine port. */
  engineTimeoutMs: number;
  defaultDepth: number; maxDepth: number; maxNodes: number;
  /** Maximum audit records read per engine for one timeline, chain check or export. */
  auditScanLimit: number;
  concurrency: number;
}>;
export const DEFAULT_AGGREGATE_CONFIG: AggregateConfig = { engineTimeoutMs: 5000, defaultDepth: 2, maxDepth: 6, maxNodes: 200, auditScanLimit: 5000, concurrency: 8 };

// ───────────────────────────── Port calls ─────────────────────────────
/** Each engine vendors its own DomainError class, so the check is structural. */
export function isDomainError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && error.name === 'DomainError' && typeof (error as { code?: unknown }).code === 'string';
}
const DENIED = new Set(['forbidden', 'unauthenticated', 'not_found', 'scope_denied', 'consent_denied', 'grant_invalid']);
export type PortResult<T> = { status: 'ok'; value: T } | { status: 'forbidden' } | { status: 'unavailable'; reason: string };

class PortTimeout extends Error {}
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PortTimeout('timeout')), ms);
    work.then((v) => { clearTimeout(timer); resolve(v); }, (e: unknown) => { clearTimeout(timer); reject(e); });
  });
}
/** Runs one port call. Denials and failures become explicit results; internal error text never leaves the engine. */
export async function callPort<T>(fn: () => Promise<T>, timeoutMs: number): Promise<PortResult<T>> {
  try { return { status: 'ok', value: await withTimeout(Promise.resolve().then(fn), timeoutMs) }; }
  catch (error) {
    if (error instanceof PortTimeout) return { status: 'unavailable', reason: 'timeout' };
    if (isDomainError(error)) return DENIED.has(error.code) ? { status: 'forbidden' } : { status: 'unavailable', reason: error.code };
    return { status: 'unavailable', reason: 'error' };
  }
}
async function pool<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i] as T);
  }));
  return out;
}
const int = (value: unknown, min: number, max: number, fallback: number, label: string): number => {
  if (value === undefined || value === null) return fallback;
  invariant(typeof value === 'number' && Number.isInteger(value) && value >= min, 'invalid_input', `${label} must be an integer of at least ${min}`);
  return Math.min(value, max);
};

// ───────────────────────────── Result types ─────────────────────────────
export type LinkedView = Readonly<{
  root: string; depth: number; direction: 'both' | 'upstream' | 'downstream';
  nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean; unavailableEngines: string[];
  /** Accessible equivalents generated from the same nodes and edges. */
  table: TableModel; nodeTable: TableModel; outline: Outline;
  generatedAt: string;
}>;
export type RefLink = Readonly<{ ref: string; engine: string; kind: string; id: string; revision: number | null }>;
export type StateBadge = Readonly<{ state: DisplayState; label: string; description: string }>;
export type ObjectView = Readonly<{
  ref: string; engine: string; engineName: string; kind: string; title: string;
  state: DisplayState; engineState: string; stale: boolean; blocked: boolean; staleReasons: string[]; badges: StateBadge[];
  sources: RefLink[]; dependents: RefLink[];
  versions: Inspection['versions']; permissions: readonly Json[]; decisions: readonly Json[]; history: Inspection['history']; data: Json;
  generatedAt: string;
}>;
export type SearchGroup = Readonly<{ engine: string; name: string; status: 'ok' | 'unavailable' | 'forbidden'; reason?: string; hits: SearchHit[] }>;
export type SearchAllResult = Readonly<{ q: string; groups: SearchGroup[]; total: number; generatedAt: string }>;
export type TimelineRecord = Readonly<{
  engine: string; id: string; tenantSeq: number; projectId: string; at: string; actorId: string; actorKind: string;
  action: string; subject: string; requestId: string; purpose: string; detail: Json; hash: string;
}>;
/** `verified`/`broken`: the complete tenant chain was read and checked. `partial`: only part was readable, so it was not checked. */
export type ChainStatus = 'verified' | 'broken' | 'partial' | 'empty' | 'not_checked';
export type TimelineEngine = Readonly<{ engine: string; name: string; status: 'ok' | 'unavailable' | 'forbidden'; reason?: string; count: number; chain: ChainStatus; exhausted: boolean }>;
export type AuditTimeline = Readonly<{
  records: TimelineRecord[]; engines: TimelineEngine[]; order: 'asc' | 'desc';
  /** True when more records exist than were returned (pass `cursors` back to continue an ascending read). */
  truncated: boolean; cursors: Record<string, string>; generatedAt: string;
}>;
export type AuditQuery = Readonly<{
  subject?: string; engines?: readonly string[]; after?: string; limit?: number; order?: 'asc' | 'desc';
  cursors?: Readonly<Record<string, string>>; verifyChains?: boolean;
}>;
export type OverviewCard = Readonly<{
  engine: string; name: string; version: string; status: 'ok' | 'degraded' | 'unavailable'; reason?: string;
  /** Numeric values reported by the engine's own `health()`; nothing is computed or estimated here. */
  counts: Record<string, number>; detail: Json;
}>;
export type Overview = Readonly<{ engines: OverviewCard[]; generatedAt: string }>;

function refLink(ref: string): RefLink | null {
  const p = parseRef(ref);
  return p === null ? null : { ref, engine: p.engine, kind: p.kind, id: p.id, revision: p.revision ?? null };
}
function cleanRefs(list: unknown, max = 500): { refs: string[]; cut: boolean } {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of Array.isArray(list) ? list : []) {
    if (typeof value !== 'string' || seen.has(value) || parseRef(value) === null) continue;
    seen.add(value); out.push(value);
  }
  return { refs: out.slice(0, max), cut: out.length > max };
}
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
export function badgesFor(inspection: { state?: string; stale?: boolean; blocked?: boolean }): StateBadge[] {
  const states: DisplayState[] = [];
  const primary = deriveState(inspection);
  if (primary === 'failed') states.push('failed');
  if (inspection.blocked === true) states.push('blocked');
  if (inspection.stale === true) states.push('stale');
  if (states.length === 0) states.push('ok');
  return states.map((state) => ({ state, label: stateLabel(state), description: STATE_DESCRIPTIONS[state] }));
}

export type Aggregator = ReturnType<typeof createAggregator>;

/**
 * `self` is E14's own StandardEngine surface (saved views, annotations …) so that E14 objects take part in linked
 * views, search and the audit timeline like any other engine's.
 */
export function createAggregator(registry: EngineRegistry, self: EnginePort, config: AggregateConfig) {
  for (const id of Object.keys(registry)) invariant(/^E\d\d$/.test(id) && id !== ENGINE_ID, 'invalid_config', `Invalid engine port id ${id}`);
  const port = (id: string): EnginePort | undefined => (id === ENGINE_ID ? self : Object.hasOwn(registry, id) ? registry[id] : undefined);
  const known = (): string[] => [...Object.keys(registry), ENGINE_ID].sort();
  const nameOf = (id: string): string => { try { return String(port(id)?.manifest.name ?? id); } catch { return id; } };
  const pick = (engines: readonly string[] | undefined): string[] => {
    if (engines === undefined) return known();
    invariant(Array.isArray(engines) && engines.length <= 32 && engines.every((e) => typeof e === 'string' && /^E\d\d$/.test(e)), 'invalid_input', 'engines must be a list of engine ids');
    return [...new Set(engines)].sort();
  };

  /** Inspects one reference with the caller's context. */
  async function inspectRef(ctx: ServiceContext, ref: string): Promise<PortResult<Inspection | null>> {
    const parsed = parseRef(ref);
    if (parsed === null) return { status: 'forbidden' };
    const p = port(parsed.engine);
    if (p === undefined) return { status: 'unavailable', reason: 'not_connected' };
    const out = await callPort(() => p.inspect(ctx, ref), config.engineTimeoutMs);
    if (out.status === 'ok' && out.value !== null && (typeof out.value !== 'object' || typeof out.value.ref !== 'string')) return { status: 'unavailable', reason: 'malformed_response' };
    return out;
  }
  /** `visible`: the caller may see the object. `hidden`: missing or not permitted (indistinguishable). */
  async function visibility(ctx: ServiceContext, ref: string): Promise<'visible' | 'hidden' | 'unavailable'> {
    const out = await inspectRef(ctx, ref);
    return out.status === 'unavailable' ? 'unavailable' : out.status === 'ok' && out.value !== null ? 'visible' : 'hidden';
  }

  function toNode(ref: string, depth: number, result: PortResult<Inspection | null>): { node: GraphNode; sources: string[]; dependents: string[]; cut: boolean } {
    const parsed = parseRef(ref) as { engine: string; kind: string };
    const empty = { ref, engine: parsed.engine, kind: parsed.kind, title: '', engineState: '', stale: false, blocked: false, staleReasons: [] as string[], versionCount: 0, permissionCount: 0, decisionCount: 0, depth };
    if (result.status === 'unavailable') return { node: { ...empty, state: 'unavailable' }, sources: [], dependents: [], cut: false };
    if (result.status === 'forbidden' || result.value === null) return { node: { ...empty, state: 'forbidden_or_missing' }, sources: [], dependents: [], cut: false };
    const i = result.value;
    const sources = cleanRefs(i.sources), dependents = cleanRefs(i.dependents);
    const canonicalRef = typeof i.ref === 'string' && parseRef(i.ref) !== null && urefMatches(ref, i.ref) ? i.ref : ref;
    return {
      node: {
        ref: canonicalRef, engine: parsed.engine, kind: typeof i.kind === 'string' && i.kind !== '' ? i.kind : parsed.kind, title: String(i.title ?? ''),
        state: deriveState(i), engineState: String(i.state ?? ''), stale: i.stale === true, blocked: i.blocked === true, staleReasons: strings(i.staleReasons),
        versionCount: Array.isArray(i.versions) ? i.versions.length : 0, permissionCount: Array.isArray(i.permissions) ? i.permissions.length : 0,
        decisionCount: Array.isArray(i.decisions) ? i.decisions.length : 0, depth,
      },
      sources: sources.refs, dependents: dependents.refs, cut: sources.cut || dependents.cut,
    };
  }

  async function inspectLinked(ctx: ServiceContext, ref: string, options: { depth?: number; direction?: 'both' | 'upstream' | 'downstream'; maxNodes?: number } = {}): Promise<LinkedView> {
    requireCapability(ctx, 'workspace:read');
    parseUref(ref);
    const depthLimit = int(options.depth, 0, config.maxDepth, config.defaultDepth, 'depth');
    const maxNodes = int(options.maxNodes, 1, config.maxNodes, config.maxNodes, 'maxNodes');
    const direction = options.direction ?? 'both';
    invariant(['both', 'upstream', 'downstream'].includes(direction), 'invalid_input', 'direction must be both, upstream or downstream');

    type Mode = 'up' | 'down';
    type Item = { ref: string; depth: number; mode: Mode | 'root'; parent?: string };
    const nodes = new Map<string, GraphNode>();
    const links = new Map<string, { sources: string[]; dependents: string[] }>();
    const alias = new Map<string, string>();
    const expanded = new Map<string, Set<Mode>>();
    const edges: GraphEdge[] = [];
    const edgeKeys = new Set<string>();
    const unavailable = new Set<string>();
    let truncated = false;
    let rootRef = ref;

    let frontier: Item[] = [{ ref, depth: 0, mode: 'root' }];
    while (frontier.length > 0) {
      const unknown: string[] = [];
      for (const item of frontier) if (!alias.has(item.ref) && !unknown.includes(item.ref)) unknown.push(item.ref);
      const room = Math.max(0, maxNodes - nodes.size);
      if (unknown.length > room) truncated = true;
      const batch = unknown.slice(0, room);
      const depthOf = new Map(frontier.map((item) => [item.ref, item.depth] as const).reverse());
      const results = await pool(batch, config.concurrency, (r) => inspectRef(ctx, r));
      batch.forEach((requested, i) => {
        const result = results[i] as PortResult<Inspection | null>;
        if (nodes.size === 0 && (result.status === 'forbidden' || (result.status === 'ok' && result.value === null))) throw new DomainError('not_found', 'Not found');
        const built = toNode(requested, depthOf.get(requested) ?? 0, result);
        if (built.node.state === 'unavailable') unavailable.add(built.node.engine);
        if (built.cut) truncated = true;
        const key = built.node.ref;
        alias.set(requested, key);
        if (!nodes.has(key)) { nodes.set(key, built.node); links.set(key, { sources: built.sources, dependents: built.dependents }); alias.set(key, key); }
        if (requested === ref) rootRef = key;
      });
      const next: Item[] = [];
      for (const item of frontier) {
        const key = alias.get(item.ref);
        if (key === undefined) continue; // dropped by the size limit
        if (item.parent !== undefined && item.parent !== key) {
          const edge: GraphEdge = { from: item.parent, to: key, relation: item.mode === 'up' ? 'source' : 'dependent' };
          const ek = item.mode === 'up' ? `${key}>${item.parent}` : `${item.parent}>${key}`;
          if (!edgeKeys.has(ek)) { edgeKeys.add(ek); edges.push(edge); }
        }
        const modes: Mode[] = item.mode === 'root' ? (direction === 'both' ? ['up', 'down'] : [direction === 'upstream' ? 'up' : 'down']) : [item.mode];
        const done = expanded.get(key) ?? new Set<Mode>();
        expanded.set(key, done);
        for (const mode of modes) {
          if (done.has(mode)) continue;
          done.add(mode);
          const link = links.get(key) as { sources: string[]; dependents: string[] };
          const list = mode === 'up' ? link.sources : link.dependents;
          if (list.length === 0) continue;
          if (item.depth >= depthLimit) { truncated = true; continue; }
          for (const other of list) next.push({ ref: other, depth: item.depth + 1, mode, parent: key });
        }
      }
      frontier = next;
    }
    const graph: Graph = { root: rootRef, nodes: [...nodes.values()], edges, truncated, unavailableEngines: [...unavailable].sort() };
    return {
      root: rootRef, depth: depthLimit, direction, nodes: graph.nodes, edges, truncated, unavailableEngines: graph.unavailableEngines as string[],
      table: relationTable(graph), nodeTable: nodeTable(graph), outline: textOutline(graph), generatedAt: ctx.now,
    };
  }

  async function inspectOne(ctx: ServiceContext, ref: string): Promise<ObjectView> {
    requireCapability(ctx, 'workspace:read');
    const parsed = parseUref(ref);
    const result = await inspectRef(ctx, ref);
    if (result.status === 'unavailable') throw new DomainError('unavailable', `Engine ${parsed.engine} is unavailable (${result.reason}); the current state of this object is unknown`);
    if (result.status === 'forbidden' || result.value === null) throw new DomainError('not_found', 'Not found');
    const i = result.value;
    const list = (refs: unknown): RefLink[] => cleanRefs(refs).refs.map((r) => refLink(r) as RefLink);
    return {
      ref: typeof i.ref === 'string' && parseRef(i.ref) !== null ? i.ref : ref, engine: parsed.engine, engineName: nameOf(parsed.engine),
      kind: String(i.kind ?? parsed.kind), title: String(i.title ?? ''), state: deriveState(i), engineState: String(i.state ?? ''),
      stale: i.stale === true, blocked: i.blocked === true, staleReasons: strings(i.staleReasons), badges: badgesFor(i),
      sources: list(i.sources), dependents: list(i.dependents),
      versions: Array.isArray(i.versions) ? i.versions : [], permissions: Array.isArray(i.permissions) ? i.permissions : [],
      decisions: Array.isArray(i.decisions) ? i.decisions : [], history: Array.isArray(i.history) ? i.history : [], data: (i.data ?? null) as Json,
      generatedAt: ctx.now,
    };
  }

  async function searchAll(ctx: ServiceContext, query: { q: string; engines?: readonly string[]; limit?: number }): Promise<SearchAllResult> {
    requireCapability(ctx, 'workspace:read');
    invariant(query !== null && typeof query === 'object' && typeof query.q === 'string' && query.q.trim().length > 0 && query.q.length <= 500, 'invalid_input', 'q must be 1 to 500 characters');
    const limit = int(query.limit, 1, 100, 20, 'limit');
    const groups = await pool(pick(query.engines), config.concurrency, async (id): Promise<SearchGroup> => {
      const p = port(id);
      if (p === undefined) return { engine: id, name: id, status: 'unavailable', reason: 'not_connected', hits: [] };
      const out = await callPort(() => p.search(ctx, { q: query.q, limit }), config.engineTimeoutMs);
      if (out.status === 'forbidden') return { engine: id, name: nameOf(id), status: 'forbidden', hits: [] };
      if (out.status === 'unavailable') return { engine: id, name: nameOf(id), status: 'unavailable', reason: out.reason, hits: [] };
      const hits = (Array.isArray(out.value) ? out.value : []).filter((h) => h !== null && typeof h === 'object' && parseRef(h.ref)?.engine === id).slice(0, limit)
        .map((h) => ({ ref: h.ref, kind: String(h.kind ?? ''), title: String(h.title ?? ''), snippet: String(h.snippet ?? ''), ...(typeof h.state === 'string' ? { state: h.state } : {}) }));
      return { engine: id, name: nameOf(id), status: 'ok', hits };
    });
    return { q: query.q, groups, total: groups.reduce((n, g) => n + g.hits.length, 0), generatedAt: ctx.now };
  }

  const PAGE = 500;
  const toRecord = (engine: string, r: AuditRecord): TimelineRecord => ({ engine, id: String(r.id), tenantSeq: r.tenantSeq, projectId: r.projectId, at: r.at, actorId: r.actorId, actorKind: r.actorKind, action: r.action, subject: r.subject, requestId: r.requestId, purpose: r.purpose, detail: r.detail, hash: r.hash });
  /** Pages through one engine's audit feed. Records outside the caller's scope are dropped even if a port returns them. */
  async function scan(ctx: ServiceContext, p: EnginePort, start: string | undefined, subject: string | undefined, max: number, each: (r: AuditRecord) => boolean): Promise<{ status: 'ok' | 'unavailable' | 'forbidden'; reason?: string; exhausted: boolean; scanned: number }> {
    let after = start, scanned = 0;
    for (;;) {
      const size = Math.min(PAGE, max - scanned);
      if (size <= 0) return { status: 'ok', exhausted: false, scanned };
      const cursor = after;
      const out = await callPort(() => p.audit(ctx, { limit: size, ...(cursor === undefined ? {} : { after: cursor }), ...(subject === undefined ? {} : { subject }) }), config.engineTimeoutMs);
      if (out.status === 'forbidden') return { status: 'forbidden', exhausted: true, scanned };
      if (out.status === 'unavailable') return { status: 'unavailable', reason: out.reason, exhausted: false, scanned };
      const page = Array.isArray(out.value) ? out.value : [];
      for (const r of page) {
        scanned += 1; after = String(r.id);
        if (r.tenantId !== ctx.tenantId || r.projectId !== ctx.projectId) continue;
        if (!each(r)) return { status: 'ok', exhausted: false, scanned };
      }
      if (page.length < size) return { status: 'ok', exhausted: true, scanned };
    }
  }
  async function chainStatus(ctx: ServiceContext, p: EnginePort): Promise<ChainStatus> {
    const all: AuditRecord[] = [];
    const out = await scan(ctx, p, undefined, undefined, config.auditScanLimit, (r) => { all.push(r); return true; });
    if (out.status !== 'ok') return 'not_checked';
    if (all.length === 0) return out.exhausted ? 'empty' : 'partial';
    // A project-scoped reader of a multi-project tenant sees gaps; the kit can only verify a complete chain.
    if (!out.exhausted || all.some((r, i) => r.tenantSeq !== i + 1)) return 'partial';
    return verifyAuditChain(all) ? 'verified' : 'broken';
  }

  async function auditTimeline(ctx: ServiceContext, query: AuditQuery = {}): Promise<AuditTimeline> {
    requireCapability(ctx, 'workspace:read');
    return timeline(ctx, query, int(query.limit, 1, 1000, 200, 'limit'));
  }
  async function timeline(ctx: ServiceContext, query: AuditQuery, limit: number): Promise<AuditTimeline> {
    const order = query.order ?? 'asc';
    invariant(order === 'asc' || order === 'desc', 'invalid_input', 'order must be asc or desc');
    if (query.subject !== undefined) parseUref(query.subject);
    const afterTime = query.after === undefined ? Number.NEGATIVE_INFINITY : Date.parse(query.after);
    invariant(!Number.isNaN(afterTime), 'invalid_input', 'after must be an ISO timestamp');
    const cursorsIn = query.cursors ?? {};
    invariant(typeof cursorsIn === 'object' && Object.entries(cursorsIn).every(([k, v]) => /^E\d\d$/.test(k) && typeof v === 'string' && /^\d{1,19}$/.test(v)), 'invalid_input', 'cursors must map engine ids to audit record ids');
    const verify = query.verifyChains !== false;

    const perEngine = await pool(pick(query.engines), config.concurrency, async (id) => {
      const p = port(id);
      if (p === undefined) return { info: { engine: id, name: id, status: 'unavailable' as const, reason: 'not_connected', count: 0, chain: 'not_checked' as ChainStatus, exhausted: false }, kept: [] as TimelineRecord[], pre: undefined as string | undefined };
      const kept: TimelineRecord[] = [];
      let pre: string | undefined = Object.hasOwn(cursorsIn, id) ? cursorsIn[id] : undefined;
      const out = await scan(ctx, p, pre, query.subject, config.auditScanLimit, (r) => {
        if (Date.parse(r.at) <= afterTime) { if (kept.length === 0) pre = String(r.id); return true; }
        kept.push(toRecord(id, r));
        if (order === 'asc') return kept.length <= limit; // one extra record proves that more exist
        if (kept.length > limit) kept.shift();
        return true;
      });
      const chain: ChainStatus = out.status === 'ok' && verify ? await chainStatus(ctx, p) : 'not_checked';
      return { info: { engine: id, name: nameOf(id), status: out.status, ...(out.reason === undefined ? {} : { reason: out.reason }), count: 0, chain, exhausted: out.exhausted }, kept, pre };
    });
    let merged: TimelineRecord[];
    if (order === 'desc') merged = perEngine.flatMap((e) => e.kept).sort(compareAudit).reverse();
    else {
      // K-way merge that never reorders one engine's own feed, so per-engine cursors stay exact even when an engine
      // recorded a timestamp out of sequence.
      merged = [];
      const heads = perEngine.map(() => 0);
      for (;;) {
        let best = -1;
        perEngine.forEach((e, i) => {
          const head = e.kept[heads[i] as number];
          if (head !== undefined && (best < 0 || compareAudit(head, perEngine[best]!.kept[heads[best] as number] as TimelineRecord) < 0)) best = i;
        });
        if (best < 0) break;
        merged.push(perEngine[best]!.kept[heads[best] as number] as TimelineRecord);
        heads[best] = (heads[best] as number) + 1;
      }
    }
    const records = merged.slice(0, limit);
    const cursors: Record<string, string> = {};
    const counts = new Map<string, number>();
    for (const r of records) counts.set(r.engine, (counts.get(r.engine) ?? 0) + 1);
    if (order === 'asc') for (const e of perEngine) {
      const taken = records.filter((r) => r.engine === e.info.engine);
      const last = taken.length > 0 ? (taken[taken.length - 1] as TimelineRecord).id : e.pre;
      if (last !== undefined) cursors[e.info.engine] = last;
    }
    return {
      records, order, cursors, generatedAt: ctx.now,
      engines: perEngine.map((e) => ({ ...e.info, count: counts.get(e.info.engine) ?? 0 })),
      truncated: merged.length > records.length || perEngine.some((e) => e.info.status === 'ok' && !e.info.exhausted),
    };
  }

  /** Builds the export body. The caller (index.ts) checks `workspace:export` and records the export in E14's audit log. */
  async function buildAuditExport(ctx: ServiceContext, query: AuditQuery & { format?: 'csv' | 'json'; includeDetail?: boolean }): Promise<{ format: 'csv' | 'json'; mediaType: string; content: string; sha256: string; recordCount: number; truncated: boolean; engines: TimelineEngine[] }> {
    const format = query.format ?? 'csv';
    invariant(format === 'csv' || format === 'json', 'invalid_input', 'format must be csv or json');
    const t = await timeline(ctx, { ...query, order: 'asc' }, int(query.limit, 1, config.auditScanLimit, config.auditScanLimit, 'limit'));
    const records = query.includeDetail === true ? t.records : t.records.map((r) => ({ ...r, detail: null }));
    const content = format === 'csv' ? auditCsv(records)
      : `${canonical(JSON.parse(JSON.stringify({ exportedAt: ctx.now, exportedBy: ctx.actor.id, tenantId: ctx.tenantId, projectId: ctx.projectId, subject: query.subject ?? null, truncated: t.truncated, engines: t.engines, records })))}\n`;
    return { format, mediaType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8', content, sha256: createHash('sha256').update(content).digest('hex'), recordCount: records.length, truncated: t.truncated, engines: t.engines };
  }

  async function overview(ctx: ServiceContext): Promise<Overview> {
    requireCapability(ctx, 'workspace:read');
    const engines = await pool(known(), config.concurrency, async (id): Promise<OverviewCard> => {
      const p = port(id) as EnginePort;
      let name = id, version = '';
      try { name = String(p.manifest.name ?? id); version = String(p.manifest.version ?? ''); } catch { /* manifest unavailable */ }
      const out = await callPort(() => p.health(), config.engineTimeoutMs);
      if (out.status !== 'ok' || out.value === null || typeof out.value !== 'object') return { engine: id, name, version, status: 'unavailable', reason: out.status === 'unavailable' ? out.reason : 'error', counts: {}, detail: null };
      const detail = (out.value.detail ?? null) as Json;
      const counts: Record<string, number> = {};
      const collect = (value: Json, prefix: string): void => {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
        for (const [k, v] of Object.entries(value)) {
          if (typeof v === 'number' && Number.isFinite(v)) counts[`${prefix}${k}`] = v;
          else if (prefix === '' && (k === 'counts' || k === 'jobs' || k === 'queue')) collect(v, k === 'counts' ? '' : `${k}.`);
        }
      };
      collect(detail, '');
      return { engine: id, name, version, status: out.value.ok === true ? 'ok' : 'degraded', counts, detail };
    });
    return { engines, generatedAt: ctx.now };
  }

  return { known, port, nameOf, inspectRef, visibility, inspectLinked, inspectOne, searchAll, auditTimeline, buildAuditExport, overview };
}
