import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import * as kit from '../src/service-kit.ts';
import { createEngine, migrate, routes } from '../src/engine/index.ts';
import { start } from '../src/engine/serve.ts';
import { ADMIN, ALL_CAPS, buildWorld, needsPg } from './engine-helpers.ts';

const key = kit.generateSigningKey('test-key');
function token(over: Partial<kit.TokenClaims> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return kit.signAccessToken({ iss: 'test-identity', sub: 'ana', kind: 'human', tid: 't1', pid: 'p1', roles: ['editor'], caps: ALL_CAPS, cmp: ['sealed'], purpose: 'test', pv: '1', iat: now, exp: now + 600, jti: `j-${Math.random()}`, ...over }, key);
}
type Reply = { status: number; body: any; text: string; headers: Headers }; // eslint-disable-line @typescript-eslint/no-explicit-any
function client(base: string) {
  return async (method: string, path: string, options: { token?: string | null; body?: unknown } = {}): Promise<Reply> => {
    const bearer = options.token === undefined ? token() : options.token;
    const response = await fetch(`${base}${path}`, { method, headers: { ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }), ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
    const text = await response.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body, text, headers: response.headers };
  };
}
const enc = encodeURIComponent;

test('HTTP end to end: in-process ports behind the kit server', needsPg, async () => {
  await kit.withDisposableDatabase(pg, ADMIN, async (url, sql) => {
    await migrate(sql);
    const w = await buildWorld(sql, url);
    const engine = createEngine({ sql, ports: { engines: w.engines, controls: { E00: w.taskControls } }, config: { engineTimeoutMs: 400, controlTimeoutMs: 400 } });
    const server = await kit.serve(kit.createHttpHandler({ name: 'E14', version: '1', routes: routes(engine), verify: kit.createTokenVerifier({ publicKeys: { 'test-key': key.publicKeyPem }, issuer: 'test-identity' }), health: engine.health }), 0);
    const call = client(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    try {
      assert.deepEqual([(await call('GET', '/healthz', { token: null })).status, (await call('GET', '/v1/manifest', { token: null })).body.id], [200, 'E14']);
      assert.equal((await call('GET', '/v1/overview', { token: null })).status, 401);
      assert.equal((await call('GET', '/v1/overview', { token: 'garbage' })).status, 401);
      const noCaps = token({ caps: ['evidence:read'] });
      assert.deepEqual([(await call('GET', '/v1/overview', { token: noCaps })).status, (await call('GET', '/v1/overview', { token: noCaps })).body.error.code], [403, 'forbidden']);

      const linked = await call('GET', `/v1/linked?ref=${enc('E08:finding:f1')}&depth=2`);
      assert.deepEqual([linked.status, linked.body.nodes.length, linked.body.edges.length, linked.body.table.rows.length, linked.body.unavailableEngines], [200, 8, 7, 8, ['E06']]);
      assert.deepEqual((await call('GET', `/v1/views/linked?ref=${enc('E08:finding:f1')}&depth=2`)).body.nodes, linked.body.nodes);
      const text = await call('GET', `/v1/linked?ref=${enc('E08:finding:f1')}&depth=2&format=text`);
      assert.match(text.headers.get('content-type') ?? '', /^text\/plain/);
      assert.equal(text.text, `${linked.body.outline.text}\n`);
      assert.deepEqual((await call('GET', `/v1/linked?ref=${enc('E08:finding:f1')}&depth=2&format=table`)).body, linked.body.table);
      assert.equal((await call('GET', '/v1/linked?ref=nonsense')).status, 400);
      assert.equal((await call('GET', `/v1/linked?ref=${enc('E08:finding:f1')}&depth=x`)).status, 400);
      assert.equal((await call('GET', '/v1/views/nothing')).status, 404);

      // Sealed and missing objects answer with byte-identical bodies (apart from the request id).
      const outsider = token({ cmp: [] });
      const strip = (r: Reply): string => JSON.stringify({ ...r.body, error: { ...r.body.error, requestId: '' } });
      const sealed = await call('GET', `/v1/objects?ref=${enc('E05:evidence:ev2')}`, { token: outsider }), missing = await call('GET', `/v1/objects?ref=${enc('E05:evidence:nope')}`, { token: outsider });
      assert.deepEqual([sealed.status, missing.status, strip(sealed)], [404, 404, strip(missing)]);
      assert.equal((await call('GET', `/v1/objects?ref=${enc('E05:evidence:ev2')}`)).body.title, 'Sealed witness statement');
      assert.equal((await call('GET', `/v1/inspect?ref=${enc('E05:evidence:ev2')}`)).status, 404, 'the standard inspect route only answers for E14 objects');
      // An unreachable engine is a real 503 with an explanation, not an opaque 500.
      const down = await call('GET', `/v1/objects?ref=${enc('E06:derivative:d1')}`);
      assert.deepEqual([down.status, down.body.error.code], [503, 'unavailable']);
      assert.match(down.body.error.message, /Engine E06 is unavailable/);

      const search = await call('GET', '/v1/search-all?q=transfer&engines=E07,E08,E06&limit=5');
      assert.deepEqual(search.body.groups.map((g: { engine: string; status: string; hits: unknown[] }) => [g.engine, g.status, g.hits.length]), [['E06', 'unavailable', 0], ['E07', 'ok', 2], ['E08', 'ok', 1]]);
      const overview = await call('GET', '/v1/views/overview');
      assert.deepEqual(overview.body.engines.map((e: { engine: string; status: string }) => `${e.engine}:${e.status}`), ['E00:ok', 'E05:ok', 'E06:unavailable', 'E07:ok', 'E08:ok', 'E09:ok', 'E14:ok']);
      assert.equal((await call('GET', '/v1/streams')).body.length, 7);

      // Saved views
      const created = await call('POST', '/v1/saved-views', { body: { name: 'HTTP board', pins: [{ ref: 'E07:claim:c1' }, { ref: 'E00:task:t1' }], sharedRoles: ['reviewer'] } });
      assert.deepEqual([created.status, created.body.revision], [201, 1]);
      const id = created.body.id as string;
      assert.equal((await call('POST', '/v1/saved-views', { body: { name: '' } })).status, 400);
      assert.equal((await call('POST', '/v1/saved-views', { body: [1] })).status, 400);
      assert.equal((await call('PATCH', `/v1/saved-views/${id}`, { body: { expectedRevision: 1, notes: 'second' } })).body.revision, 2);
      const conflict = await call('PATCH', `/v1/saved-views/${id}`, { body: { expectedRevision: 1, notes: 'late' } });
      assert.deepEqual([conflict.status, conflict.body.error.code], [409, 'revision_conflict']);
      assert.deepEqual((await call('GET', `/v1/saved-views/${id}/revisions`)).body.map((r: { revision: number }) => r.revision), [1, 2]);
      assert.equal((await call('GET', `/v1/saved-views/${id}?revision=1`)).body.notes, '');
      assert.deepEqual((await call('GET', `/v1/saved-views/${id}/board`)).body.pins.map((p: { state: string }) => p.state), ['ok', 'ok']);
      assert.equal((await call('GET', '/v1/saved-views')).body.length, 1);
      const stranger = token({ sub: 'sam', roles: [] });
      assert.equal((await call('GET', `/v1/saved-views/${id}`, { token: stranger })).status, 404);
      assert.equal((await call('GET', `/v1/saved-views/${id}`, { token: token({ tid: 't2' }) })).status, 404);
      assert.equal((await call('GET', '/v1/saved-views/not-a-uuid')).status, 404);
      const change = await call('POST', '/v1/upstream-changes', { body: { eventId: 'evt-9', kind: 'claim_changed', refs: ['E07:claim:c1'], reason: 'Corrected' } });
      assert.deepEqual(change.body.affected, [`E14:view:${id}@2`]);
      assert.equal((await call('GET', `/v1/saved-views/${id}`)).body.stale, true);
      assert.equal((await call('GET', `/v1/inspect?ref=${enc(`E14:view:${id}`)}`)).body.stale, true);
      assert.equal((await call('POST', `/v1/saved-views/${id}/acknowledge`, { body: {} })).body.stale, false);
      assert.equal((await call('POST', `/v1/saved-views/${id}/archive`, { body: { expectedRevision: 2 } })).body.archived, true);

      // Annotations
      const note = await call('POST', '/v1/annotations', { body: { ref: 'E07:claim:c1', kind: 'review', body: 'Looks right' } });
      assert.equal(note.status, 201);
      assert.equal((await call('GET', `/v1/annotations?ref=${enc('E07:claim:c1')}`)).body.annotations.length, 1);
      assert.equal((await call('POST', `/v1/annotations/${note.body.id}/resolve`, { body: { resolution: 'ok' } })).body.status, 'resolved');
      assert.equal((await call('POST', `/v1/annotations/${note.body.id}/resolve`, { body: {} })).status, 409);
      assert.equal((await call('POST', '/v1/annotations', { body: { ref: 'E06:derivative:d1', body: 'x' } })).status, 503);

      // Controls: real outcomes and real errors.
      const controls = await call('GET', `/v1/controls?ref=${enc('E00:task:t1')}`);
      assert.deepEqual(controls.body.controls.map((c: { id: string }) => c.id).slice(0, 4), ['task.pause', 'task.resume', 'task.cancel', 'task.reassign']);
      const needsConfirm = await call('POST', '/v1/controls/invoke', { body: { ref: 'E00:task:t1', controlId: 'task.cancel', input: { reason: 'dup' } } });
      assert.deepEqual([needsConfirm.status, needsConfirm.body.error.code], [409, 'confirmation_required']);
      const paused = await call('POST', '/v1/controls/invoke', { body: { ref: 'E00:task:t1', controlId: 'task.pause', idempotencyKey: 'h1' } });
      assert.deepEqual([paused.status, paused.body.outcome, paused.body.result], [200, 'succeeded', { id: 't1', state: 'paused' }]);
      const refused = await call('POST', '/v1/controls/invoke', { body: { ref: 'E00:task:t1', controlId: 'task.pause' } });
      assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.message, typeof refused.body.error.invocationId], [409, 'invalid_state', 'Task in state paused cannot pause', 'string']);
      const denied = await call('POST', '/v1/controls/invoke', { token: token({ sub: 'cy', caps: ALL_CAPS.filter((c) => c !== 'orchestration:write') }), body: { ref: 'E00:task:t1', controlId: 'task.resume' } });
      assert.deepEqual([denied.status, denied.body.error.code], [403, 'forbidden']);
      assert.equal((await call('POST', '/v1/controls/invoke', { body: { ref: 'E00:task:t1', controlId: 'task.nope' } })).status, 404);
      assert.equal((await call('POST', '/v1/controls/invoke', { body: { ref: 'E00:task:t1' } })).status, 400);
      w.taskControls.hang = true;
      const hung = await call('POST', '/v1/controls/invoke', { body: { ref: 'E00:task:t2', controlId: 'task.pause' } });
      assert.deepEqual([hung.status, hung.body.error.code], [504, 'control_uncertain']);
      w.taskControls.hang = false;
      assert.deepEqual((await call('GET', `/v1/control-invocations?ref=${enc('E00:task:t1')}`)).body.map((i: { outcome: string }) => i.outcome).sort(), ['denied', 'failed', 'succeeded']);

      // Audit timeline and export
      const timeline = await call('GET', `/v1/audit-timeline?engines=E00,E14&order=desc&limit=5`);
      assert.deepEqual([timeline.status, timeline.body.records.length, timeline.body.order], [200, 5, 'desc']);
      const subject = await call('GET', `/v1/audit/resources/${enc('E00:task:t1')}?verify=0`);
      assert.ok(subject.body.records.length >= 5 && subject.body.records.every((r: { subject: string }) => r.subject === 'E00:task:t1'));
      assert.ok(subject.body.engines.every((e: { chain: string }) => e.chain === 'not_checked'));
      const csv = await call('GET', `/v1/audit-timeline/export?format=csv&subject=${enc('E00:task:t1')}`);
      assert.deepEqual([csv.status, csv.headers.get('content-type'), csv.headers.get('x-export-records')], [200, 'text/csv; charset=utf-8', String(subject.body.records.length)]);
      assert.match(csv.headers.get('content-disposition') ?? '', /^attachment; filename="audit-.*\.csv"$/);
      assert.match(csv.text, /^"at","engine","id"/);
      const envelope = await call('POST', '/v1/audit-exports', { body: { format: 'json', engines: ['E14'] } });
      assert.deepEqual([envelope.status, envelope.body.format, typeof envelope.body.sha256], [200, 'json', 'string']);
      assert.equal((await call('GET', '/v1/audit-timeline/export?format=csv', { token: token({ caps: ALL_CAPS.filter((c) => c !== 'workspace:export') }) })).status, 403);
      assert.equal((await call('GET', '/v1/audit-timeline?after=yesterday')).status, 400);
      assert.equal((await call('GET', '/v1/events', { token: token({ caps: ['workspace:read', 'workspace:*'] }) })).status, 403);
      assert.ok(Array.isArray((await call('GET', '/v1/events')).body));
      assert.equal((await call('GET', '/v1/audit')).body[0].action, 'view.created');
    } finally { await new Promise<void>((r) => server.close(() => r())); }
  });
});

test('HTTP end to end: standalone server reading another engine over HTTP with the caller\'s own token', needsPg, async () => {
  await kit.withDisposableDatabase(pg, ADMIN, async (url, sql) => {
    const w = await buildWorld(sql, url);
    // The knowledge and evidence test engines run as separate HTTP services with the same identity keys.
    const verify = kit.createTokenVerifier({ publicKeys: { 'test-key': key.publicKeyPem } });
    const seen: string[] = [];
    const remote = async (engine: kit.StandardEngine, name: string) => kit.serve(kit.createHttpHandler({ name, version: '0.0.1', routes: kit.standardRoutes(engine), verify: async (t, r) => { seen.push(t); return verify(t, r); }, health: engine.health }), 0);
    const e05 = await remote(w.e05, 'E05'), e07 = await remote(w.e07, 'E07');
    const port = (s: typeof e05): number => (s.address() as AddressInfo).port;
    const served = await start({ DATABASE_URL: url, PORT: '0', IDENTITY_PUBLIC_KEYS: JSON.stringify({ 'test-key': key.publicKeyPem }), WORKSPACE_ENGINE_TIMEOUT_MS: '2000',
      WORKSPACE_ENGINE_URLS: JSON.stringify({ E05: `http://127.0.0.1:${port(e05)}`, E07: `http://127.0.0.1:${port(e07)}`, E08: 'http://127.0.0.1:1' }) });
    const call = client(`http://127.0.0.1:${served.port}`);
    try {
      const mine = token();
      const linked = await call('GET', `/v1/linked?ref=${enc('E07:claim:c1')}&depth=2`, { token: mine });
      assert.deepEqual(linked.body.nodes.map((n: { ref: string; state: string }) => `${n.ref}=${n.state}`).sort(), ['E05:evidence:ev1@1=ok', 'E05:evidence:ev2@1=ok', 'E07:claim:c1@1=ok', 'E08:finding:f1=unavailable']);
      assert.ok(seen.length >= 3 && seen.every((t) => t === mine), 'the remote engines were called with the caller\'s own token');
      // A caller the remote engine does not authorise gets nothing through E14 either.
      const limited = token({ caps: ['workspace:read', 'knowledge:read'], cmp: [] });
      const partial = await call('GET', `/v1/linked?ref=${enc('E07:claim:c1')}&depth=1&direction=upstream`, { token: limited });
      assert.deepEqual(partial.body.nodes.map((n: { ref: string; state: string }) => `${n.ref}=${n.state}`).sort(), ['E05:evidence:ev1@1=forbidden_or_missing', 'E05:evidence:ev2=forbidden_or_missing', 'E07:claim:c1@1=ok']);
      assert.equal((await call('GET', `/v1/objects?ref=${enc('E05:evidence:ev1')}`, { token: limited })).status, 404);
      assert.equal((await call('GET', `/v1/objects?ref=${enc('E07:claim:c1')}`, { token: token({ tid: 't2' }) })).status, 404);
      const search = await call('GET', '/v1/search-all?q=ledger', { token: mine });
      assert.deepEqual(search.body.groups.map((g: { engine: string; status: string; hits: unknown[] }) => [g.engine, g.status, g.hits.length]), [['E05', 'ok', 1], ['E07', 'ok', 1], ['E08', 'unavailable', 0], ['E14', 'ok', 0]]);
      const timeline = await call('GET', '/v1/audit-timeline?engines=E07', { token: mine });
      assert.deepEqual([timeline.body.records.length, timeline.body.engines[0].chain], [4, 'verified']);
      const overview = await call('GET', '/v1/overview', { token: mine });
      assert.deepEqual(overview.body.engines.map((e: { engine: string; status: string; name: string }) => [e.engine, e.status, e.name]), [['E05', 'ok', 'Test evidence'], ['E07', 'ok', 'Test knowledge'], ['E08', 'unavailable', 'E08'], ['E14', 'ok', 'Visual workspace and audit']]);
      assert.deepEqual(overview.body.engines[1].counts, { things: 4 });
      // Static component library
      const js = await call('GET', '/web/model.js', { token: null });
      assert.deepEqual([js.status, js.headers.get('content-type')], [200, 'text/javascript; charset=utf-8']);
      assert.equal((await call('GET', '/web/..%2Fpackage.json', { token: null })).status, 404);
      assert.equal((await call('GET', '/web/model.d.ts', { token: null })).status, 404);
    } finally {
      await served.close();
      await Promise.all([e05, e07].map((s) => new Promise<void>((r) => s.close(() => r()))));
    }
  });
  await assert.rejects(start({ PORT: '0' }), /DATABASE_URL is required/);
  await assert.rejects(start({ DATABASE_URL: 'postgresql://x', PORT: '0' }), /IDENTITY_PUBLIC_KEYS/);
});
