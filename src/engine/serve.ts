// Standalone server: reads env, runs migrations and serves the HTTP API plus the static browser components.
// E14 has no background jobs, so there is no worker loop.
import pg from 'pg';
import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { DomainError } from '../contracts.ts';
import type { Json } from '../contracts.ts';
import { createHttpHandler, createTokenVerifier, pgSql, serve } from '../service-kit.ts';
import type { AuditRecord, EngineManifestV1, Inspection, PgPoolLike, Route, SearchHit, ServiceContext, TokenVerifier } from '../service-kit.ts';
import { createEngine, manifest, migrate, routes } from './index.ts';
import type { EngineConfig, EnginePort, WorkspaceEngine } from './index.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type Served = Readonly<{ server: Server; engine: WorkspaceEngine; port: number; close(): Promise<void> }>;
const num = (value: string | undefined): number | undefined => (value === undefined || value === '' || !Number.isFinite(Number(value)) ? undefined : Number(value));

export function publicKeysFromEnv(env: Env): Record<string, string> {
  const raw = env.IDENTITY_PUBLIC_KEYS ?? (env.IDENTITY_JWKS_FILE === undefined ? undefined : readFileSync(env.IDENTITY_JWKS_FILE, 'utf8'));
  if (raw === undefined || raw === '') throw new Error('IDENTITY_PUBLIC_KEYS (JSON map kid→PEM) or IDENTITY_JWKS_FILE is required');
  const parsed = JSON.parse(raw) as Record<string, unknown> & { keys?: { kid?: string }[] };
  if (Array.isArray(parsed.keys)) return Object.fromEntries(parsed.keys.map((k) => [String(k.kid), createPublicKey({ key: k as never, format: 'jwk' }).export({ type: 'spki', format: 'pem' }).toString()]));
  return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
}
export function configFromEnv(env: Env): EngineConfig {
  const pairs: [keyof EngineConfig, number | undefined][] = [
    ['engineTimeoutMs', num(env.WORKSPACE_ENGINE_TIMEOUT_MS)], ['controlTimeoutMs', num(env.WORKSPACE_CONTROL_TIMEOUT_MS)], ['maxNodes', num(env.WORKSPACE_MAX_NODES)],
    ['maxDepth', num(env.WORKSPACE_MAX_DEPTH)], ['auditScanLimit', num(env.WORKSPACE_AUDIT_SCAN_LIMIT)],
  ];
  return Object.fromEntries(pairs.filter(([, v]) => v !== undefined && v > 0)) as EngineConfig;
}

/**
 * Reads another engine's standard HTTP surface as an EnginePort. Every request carries the CALLER's own bearer token
 * (looked up from the request context), so the remote engine applies its own authorization; there is no service identity.
 */
export function httpEnginePort(id: string, baseUrl: string, tokenOf: (ctx: ServiceContext) => string | undefined, fetchImpl: typeof fetch = fetch): EnginePort {
  let described: EngineManifestV1 = { id, name: id, version: '', kit: '', capabilities: [], emits: [], consumes: [] };
  const get = async <T>(ctx: ServiceContext | null, path: string, missing?: T): Promise<T> => {
    const headers: Record<string, string> = {};
    if (ctx !== null) {
      const token = tokenOf(ctx);
      if (token === undefined) throw new DomainError('unauthenticated', 'No caller credentials to forward');
      headers.authorization = `Bearer ${token}`; headers['x-request-id'] = ctx.requestId;
    }
    const response = await fetchImpl(new URL(path, baseUrl), { headers, redirect: 'error' });
    if (response.status === 404 && missing !== undefined) return missing;
    if (!response.ok) {
      let code = response.status >= 500 ? 'unavailable' : 'forbidden';
      try { code = ((await response.json()) as { error?: { code?: string } }).error?.code ?? code; } catch { /* non-JSON error body */ }
      throw new DomainError(code === 'internal' ? 'unavailable' : code, `Engine ${id} answered ${response.status}`);
    }
    return await response.json() as T;
  };
  const qs = (params: Record<string, string | number | undefined>): string => new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
  void get<EngineManifestV1>(null, '/v1/manifest').then((m) => { if (m !== null && typeof m === 'object' && m.id === id) described = m; }, () => { /* shown as unavailable by health() */ });
  return {
    get manifest(): EngineManifestV1 { return described; },
    inspect: (ctx, ref) => get<Inspection | null>(ctx, `/v1/inspect?${qs({ ref })}`, null),
    search: (ctx, query) => get<SearchHit[]>(ctx, `/v1/search?${qs({ q: query.q, limit: query.limit })}`),
    audit: (ctx, options = {}) => get<AuditRecord[]>(ctx, `/v1/audit?${qs({ after: options.after, limit: options.limit, subject: options.subject })}`),
    health: async () => {
      const response = await fetchImpl(new URL('/healthz', baseUrl), { redirect: 'error' });
      const body = await response.json() as { ok?: boolean; detail?: Json; version?: string; engine?: string };
      if (typeof body.version === 'string' && described.version === '') described = { ...described, version: body.version };
      return { ok: body.ok === true, detail: body.detail ?? null };
    },
  };
}

export const WEB_DIR = fileURLToPath(new URL('../../web/', import.meta.url));
const WEB_TYPES: Readonly<Record<string, string>> = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', html: 'text/html; charset=utf-8', json: 'application/json; charset=utf-8', svg: 'image/svg+xml' };
/** Public, read-only routes for the browser component library (`<prefix>/index.js`, `<prefix>/workspace.css`, …). */
export function webRoutes(prefix = '/web', directory = WEB_DIR): Route[] {
  return [{ method: 'GET', path: `${prefix}/:file`, public: true, handler: async (r) => {
    const file = r.params.file ?? '';
    const type = WEB_TYPES[file.split('.').pop() ?? ''];
    if (type === undefined || !/^[a-z0-9][a-z0-9._-]{0,80}$/.test(file) || file.includes('..')) throw new DomainError('not_found', 'Not found');
    try { return { bytes: new Uint8Array(await readFile(`${directory}${file}`)), headers: { 'content-type': type, 'cache-control': 'no-cache', 'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'self'" } }; }
    catch { throw new DomainError('not_found', 'Not found'); }
  } }];
}

export async function start(env: Env = process.env): Promise<Served> {
  if (env.DATABASE_URL === undefined || env.DATABASE_URL === '') throw new Error('DATABASE_URL is required');
  const verifyToken = createTokenVerifier({ publicKeys: publicKeysFromEnv(env), ...(env.IDENTITY_ISSUER === undefined || env.IDENTITY_ISSUER === '' ? {} : { issuer: env.IDENTITY_ISSUER }) });
  // The caller's token is remembered per request context only so that it can be forwarded to the engines being read.
  const tokens = new WeakMap<ServiceContext, string>();
  const verify: TokenVerifier = async (token, request) => { const ctx = await verifyToken(token, request); tokens.set(ctx, token); return ctx; };
  const urls = env.WORKSPACE_ENGINE_URLS === undefined || env.WORKSPACE_ENGINE_URLS === '' ? {} : JSON.parse(env.WORKSPACE_ENGINE_URLS) as Record<string, string>;
  const engines: Record<string, EnginePort> = {};
  for (const [id, url] of Object.entries(urls)) {
    if (!/^E\d\d$/.test(id) || id === manifest.id) throw new Error(`WORKSPACE_ENGINE_URLS: invalid engine id ${id}`);
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`WORKSPACE_ENGINE_URLS: ${id} must be an http(s) URL`);
    engines[id] = httpEnginePort(id, parsed.toString(), (ctx) => tokens.get(ctx));
  }
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: num(env.DATABASE_POOL_MAX) ?? 10 });
  const sql = pgSql(pool as unknown as PgPoolLike);
  await migrate(sql);
  const engine = createEngine({ sql, ports: { engines }, config: configFromEnv(env) });
  const log = (line: Record<string, unknown>): void => { process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), engine: manifest.id, ...line })}\n`); };
  const handler = createHttpHandler({ name: manifest.id, version: manifest.version, routes: [...routes(engine), ...(env.WORKSPACE_SERVE_WEB === '0' ? [] : webRoutes())], verify, maxBodyBytes: 1024 * 1024, health: engine.health,
    // Only the error class and request coordinates are logged: never bodies, credentials or tokens.
    onError: (error, info) => log({ level: 'error', ...info, error: error instanceof Error ? error.name : 'unknown' }) });
  const server = await serve(handler, num(env.PORT) ?? 8080, env.HOST ?? '127.0.0.1');
  const address = server.address();
  return { server, engine, port: typeof address === 'object' && address !== null ? address.port : 0, close: async () => { await new Promise<void>((r) => server.close(() => r())); await pool.end(); } };
}
if (import.meta.main) {
  start().then((s) => { process.stderr.write(`${JSON.stringify({ engine: manifest.id, listening: s.port })}\n`); for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { void s.close().then(() => process.exit(0)); }); },
    (error: unknown) => { process.stderr.write(`${manifest.id} failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`); process.exit(1); });
}
