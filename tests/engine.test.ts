import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { DomainError } from '../src/contracts.ts';
import * as kit from '../src/service-kit.ts';
import { createEngine, migrate, validateControlInput } from '../src/engine/index.ts';
import type { LinkedView, WorkspaceEngine } from '../src/engine/index.ts';
import { canonicalEdge, edgeKey } from '../web/model.js';
import { ADMIN, ALL_CAPS, buildWorld, code, ctxOf, needsPg, poll } from './engine-helpers.ts';
import type { World } from './engine-helpers.ts';

async function world(fn: (w: World, engine: WorkspaceEngine) => Promise<void>, config: Parameters<typeof createEngine>[0]['config'] = { engineTimeoutMs: 400, controlTimeoutMs: 400 }): Promise<void> {
  await kit.withDisposableDatabase(pg, ADMIN, async (url, sql) => {
    await migrate(sql);
    const w = await buildWorld(sql, url);
    await fn(w, createEngine({ sql, ports: { engines: w.engines, controls: { E00: w.taskControls } }, config }));
  });
}
const caps = (...remove: string[]): string[] => ALL_CAPS.filter((c) => !remove.includes(c));
const edgeSet = (view: LinkedView): string[] => view.edges.map(edgeKey).sort();

test('migrations are idempotent and the manifest names the kit', needsPg, async () => {
  await kit.withDisposableDatabase(pg, ADMIN, async (_url, sql) => {
    assert.deepEqual(await migrate(sql), ['001_workspace']);
    assert.deepEqual(await migrate(sql), []);
    const engine = createEngine({ sql });
    assert.equal(engine.manifest.id, 'E14'); assert.equal(engine.manifest.kit, kit.SERVICE_KIT_VERSION);
    assert.equal((await engine.health()).ok, true);
    // Works standalone with no ports: nothing to aggregate, own data still usable.
    const view = await engine.createView(ctxOf(), { name: 'Empty board' });
    assert.equal((await engine.inspectLinked(ctxOf(), view.ref)).nodes.length, 1);
    assert.deepEqual((await engine.overview(ctxOf())).engines.map((e) => e.engine), ['E14']);
  });
});

test('linked view: graph, table and text outline carry the same nodes and edges, with explicit states', needsPg, async () => {
  await world(async (_w, engine) => {
    const view = await engine.inspectLinked(ctxOf(), 'E08:finding:f1', { depth: 2 });
    assert.equal(view.root, 'E08:finding:f1@1');
    const state = Object.fromEntries(view.nodes.map((n) => [n.ref, n.state]));
    assert.deepEqual(state, {
      'E08:finding:f1@1': 'ok', 'E07:claim:c1@1': 'ok', 'E06:derivative:d1': 'unavailable', 'E05:evidence:ev1@1': 'ok', 'E05:evidence:ev2@1': 'ok',
      'E09:scene:s1@1': 'blocked', 'E00:task:t1@1': 'ok', 'E00:task:t2@1': 'ok',
    });
    assert.deepEqual(view.unavailableEngines, ['E06']);
    assert.equal(view.truncated, false);
    assert.deepEqual(edgeSet(view), [
      'E00:task:t1@1 -> E00:task:t2@1', 'E05:evidence:ev1@1 -> E07:claim:c1@1', 'E05:evidence:ev2@1 -> E07:claim:c1@1', 'E06:derivative:d1 -> E08:finding:f1@1',
      'E07:claim:c1@1 -> E08:finding:f1@1', 'E08:finding:f1@1 -> E00:task:t1@1', 'E08:finding:f1@1 -> E09:scene:s1@1',
    ]);
    const scene = view.nodes.find((n) => n.ref === 'E09:scene:s1@1')!;
    assert.deepEqual([scene.blocked, scene.staleReasons, scene.permissionCount, scene.engine, scene.kind, scene.title], [true, ['permission withdrawn'], 1, 'E09', 'scene', 'Scene one']);
    const down = view.nodes.find((n) => n.ref === 'E06:derivative:d1')!;
    assert.deepEqual([down.title, down.engineState, down.versionCount], ['', '', 0]);

    // Table equivalent: first row is the selected object, then one row per relationship.
    const tableNodes = new Set(view.table.rows.map((r) => r.to as string));
    assert.deepEqual([...tableNodes].sort(), view.nodes.map((n) => n.ref).sort());
    const tableEdges = view.table.rows.filter((r) => r.relation !== 'root').map((r) => edgeKey({ from: r.from as string, to: r.to as string, relation: r.relation as 'source' })).sort();
    assert.deepEqual(tableEdges, edgeSet(view));
    assert.equal(view.table.rows[0]!.relation, 'root');
    assert.ok(view.table.rows.some((r) => r.to === 'E06:derivative:d1' && r.toStateLabel === 'Unavailable'));
    assert.ok(view.table.rows.some((r) => r.to === 'E09:scene:s1@1' && r.toStateLabel === 'Blocked' && r.toReasons === 'permission withdrawn'));
    assert.deepEqual(view.nodeTable.rows.map((r) => r.ref).sort(), view.nodes.map((n) => n.ref).sort());

    // Text equivalent: every node and edge appears as an indented line.
    const lines = view.outline.lines.filter((l) => l.ref !== null);
    assert.deepEqual([...new Set(lines.map((l) => l.ref))].sort(), view.nodes.map((n) => n.ref).sort());
    const outlineEdges = lines.filter((l) => l.parent !== null).map((l) => edgeKey(l.relation === 'source' ? { from: l.parent!, to: l.ref!, relation: 'source' } : { from: l.parent!, to: l.ref!, relation: 'dependent' }));
    assert.deepEqual([...new Set(outlineEdges)].sort(), edgeSet(view));
    assert.match(view.outline.text, /^Selected: Finding on the transfer \[E08 finding\] - OK - E08:finding:f1@1$/m);
    assert.match(view.outline.text, /^ {4}2\. Ledger shows a transfer \[E07 claim\] - OK - E07:claim:c1@1$/m);
    assert.match(view.outline.text, /^ {6}1\. Harbour ledger scan \[E05 evidence\] - OK - E05:evidence:ev1@1$/m);
    assert.match(view.outline.text, /Scene one \[E09 scene\] - Blocked \(permission withdrawn\)/);
    assert.match(view.outline.text, /\(title not available\) \[E06 derivative\] - Unavailable - E06:derivative:d1/);
    assert.match(view.outline.text, /Unavailable engines \(state unknown\): E06\./);
    assert.ok(!view.outline.text.includes('connection refused'), 'internal error text never leaves the port');

    // Stale, failed and not-connected states are explicit.
    const stale = await engine.inspectLinked(ctxOf(), 'E07:claim:c2');
    assert.deepEqual([stale.nodes[0]!.state, stale.nodes[0]!.stale, stale.nodes[0]!.staleReasons, stale.nodes[0]!.decisionCount], ['stale', true, ['source corrected'], 1]);
    assert.equal((await engine.inspectLinked(ctxOf(), 'E00:task:t3')).nodes[0]!.state, 'failed');
    const scenes = await engine.inspectLinked(ctxOf(), 'E09:scene:s1', { direction: 'upstream', depth: 1 });
    assert.equal(scenes.nodes.find((n) => n.ref === 'E11:permission:p1')!.state, 'unavailable');
    assert.deepEqual(scenes.unavailableEngines, ['E11']);
    assert.equal(scenes.truncated, true, 'the finding has sources beyond depth 1');
    // A root in an engine that is down is shown as unavailable rather than hidden or reported missing.
    const downRoot = await engine.inspectLinked(ctxOf(), 'E06:derivative:d1');
    assert.deepEqual(downRoot.nodes.map((n) => n.state), ['unavailable']);
  });
});

test('linked view: depth and size limits, direction, cycles', needsPg, async () => {
  await world(async (_w, engine) => {
    const zero = await engine.inspectLinked(ctxOf(), 'E08:finding:f1', { depth: 0 });
    assert.deepEqual([zero.nodes.length, zero.edges.length, zero.truncated], [1, 0, true]);
    const one = await engine.inspectLinked(ctxOf(), 'E08:finding:f1', { depth: 1 });
    assert.deepEqual(one.nodes.map((n) => n.ref).sort(), ['E00:task:t1@1', 'E06:derivative:d1', 'E07:claim:c1@1', 'E08:finding:f1@1', 'E09:scene:s1@1']);
    assert.equal(one.truncated, true);
    assert.deepEqual(one.nodes.map((n) => n.depth).sort(), [0, 1, 1, 1, 1]);
    const up = await engine.inspectLinked(ctxOf(), 'E08:finding:f1', { depth: 3, direction: 'upstream' });
    assert.ok(up.nodes.every((n) => !n.ref.startsWith('E00') && !n.ref.startsWith('E09')));
    assert.equal(up.truncated, false);
    const downstream = await engine.inspectLinked(ctxOf(), 'E05:evidence:ev1', { depth: 3, direction: 'downstream' });
    assert.deepEqual(downstream.nodes.map((n) => n.ref), ['E05:evidence:ev1@1'], 'the test evidence engine records no dependents; nothing is inferred');
    const small = await engine.inspectLinked(ctxOf(), 'E08:finding:f1', { depth: 3, maxNodes: 3 });
    assert.deepEqual([small.nodes.length, small.truncated], [3, true]);
    assert.ok(small.edges.every((e) => small.nodes.some((n) => n.ref === e.from) && small.nodes.some((n) => n.ref === e.to)));

    const cycle = await engine.inspectLinked(ctxOf(), 'E07:claim:cyA', { depth: 6 });
    assert.deepEqual(cycle.nodes.map((n) => n.ref).sort(), ['E07:claim:cyA@1', 'E07:claim:cyB@1']);
    assert.deepEqual(edgeSet(cycle), ['E07:claim:cyA@1 -> E07:claim:cyB@1', 'E07:claim:cyB@1 -> E07:claim:cyA@1']);
    assert.equal(cycle.truncated, false);
    assert.match(cycle.outline.text, /\(listed above\)/);
    assert.ok(cycle.outline.lines.length < 12, 'the outline terminates on cycles');
    for (const e of cycle.edges) assert.ok(canonicalEdge(e).upstream !== canonicalEdge(e).downstream);

    await assert.rejects(engine.inspectLinked(ctxOf(), 'not a ref'), code('invalid_reference'));
    await assert.rejects(engine.inspectLinked(ctxOf(), 'E08:finding:f1', { depth: -1 }), code('invalid_input'));
    await assert.rejects(engine.inspectLinked(ctxOf(), 'E08:finding:f1', { direction: 'sideways' as 'both' }), code('invalid_input'));
    assert.equal((await engine.inspectLinked(ctxOf(), 'E08:finding:f1', { depth: 99 })).depth, 6, 'depth is capped');
  });
});

test('forbidden and missing objects are indistinguishable', needsPg, async () => {
  await world(async (_w, engine) => {
    const outsider = ctxOf({ compartments: [] });
    const describe = async (fn: () => Promise<unknown>): Promise<string> => { try { await fn(); return 'ok'; } catch (e) { return `${(e as DomainError).code}|${(e as Error).message}`; } };
    const sealed = await describe(() => engine.inspectOne(outsider, 'E05:evidence:ev2'));
    assert.equal(sealed, 'not_found|Not found');
    assert.equal(await describe(() => engine.inspectOne(outsider, 'E05:evidence:nope')), sealed);
    assert.equal(await describe(() => engine.inspectLinked(outsider, 'E05:evidence:ev2')), sealed);
    assert.equal(await describe(() => engine.inspectLinked(outsider, 'E05:evidence:nope')), sealed);
    assert.equal(await describe(() => engine.listControls(outsider, 'E05:evidence:ev2')), sealed);
    assert.equal(await describe(() => engine.listControls(outsider, 'E05:evidence:nope')), sealed);
    assert.equal(await describe(() => engine.listAnnotations(outsider, { ref: 'E05:evidence:ev2' })), sealed);
    // No capability in the owning engine at all looks the same again.
    const noEvidence = ctxOf({ capabilities: caps('evidence:read', 'evidence:write') });
    assert.equal(await describe(() => engine.inspectOne(noEvidence, 'E05:evidence:ev1')), sealed);

    // As a neighbour, a sealed object is listed by reference only; it is the same shape as a reference to nothing.
    const view = await engine.inspectLinked(outsider, 'E07:claim:c1', { direction: 'upstream' });
    const hidden = view.nodes.find((n) => n.ref === 'E05:evidence:ev2')!;
    assert.deepEqual({ ...hidden, ref: '' }, { ref: '', engine: 'E05', kind: 'evidence', title: '', state: 'forbidden_or_missing', engineState: '', stale: false, blocked: false, staleReasons: [], versionCount: 0, permissionCount: 0, decisionCount: 0, depth: 1 });
    assert.ok(!JSON.stringify(view).includes('Sealed witness statement'));
    assert.match(view.outline.text, /\(title not available\) \[E05 evidence\] - Not found or not permitted - E05:evidence:ev2/);
    assert.deepEqual(view.unavailableEngines, []);
    // Search never returns the sealed title to someone outside the compartment.
    const hits = await engine.searchAll(outsider, { q: 'witness' });
    assert.equal(hits.total, 0);
    assert.equal((await engine.searchAll(ctxOf(), { q: 'witness' })).total, 1);
  });
});

test('fail-closed authorization on every method', needsPg, async () => {
  await world(async (w, engine) => {
    const none = ctxOf({ capabilities: caps('workspace:read', 'workspace:write', 'workspace:control', 'workspace:export', 'workspace:events') });
    const readOnly = ctxOf({ capabilities: caps('workspace:write', 'workspace:control', 'workspace:export', 'workspace:events') });
    const view = await engine.createView(ctxOf(), { name: 'Board' });
    const note = await engine.annotate(ctxOf(), { ref: 'E07:claim:c1', body: 'Check the date' });
    const before = w.e07.calls.length;
    const reads: (() => Promise<unknown>)[] = [
      () => engine.inspectLinked(none, 'E07:claim:c1'), () => engine.inspectOne(none, 'E07:claim:c1'), () => engine.searchAll(none, { q: 'ledger' }), () => engine.auditTimeline(none), () => engine.overview(none),
      () => engine.listEngines(none), () => engine.getView(none, view.id), () => engine.listViews(none), () => engine.listViewRevisions(none, view.id), () => engine.resolveView(none, view.id),
      () => engine.listAnnotations(none), () => engine.listControls(none, 'E00:task:t1'), () => engine.listControlInvocations(none), () => engine.inspect(none, view.ref), () => engine.search(none, { q: 'Board' }), () => engine.audit(none),
      () => engine.exportAudit(none),
    ];
    for (const fn of reads) await assert.rejects(fn(), code('forbidden'));
    assert.equal(w.e07.calls.length, before, 'no engine is contacted for a caller without workspace:read');
    const writes: (() => Promise<unknown>)[] = [
      () => engine.createView(readOnly, { name: 'x' }), () => engine.updateView(readOnly, view.id, { expectedRevision: 1, name: 'y' }), () => engine.archiveView(readOnly, view.id, { expectedRevision: 1 }),
      () => engine.acknowledgeViewFlags(readOnly, view.id), () => engine.annotate(readOnly, { ref: 'E07:claim:c1', body: 'x' }), () => engine.resolveAnnotation(readOnly, note.id),
      () => engine.invokeControl(readOnly, 'E00:task:t1', 'task.pause'), () => engine.exportAudit(readOnly), () => engine.events(readOnly),
      () => engine.applyUpstreamChange(readOnly, { eventId: 'e', kind: 'source_corrected', refs: [], reason: '' }),
    ];
    for (const fn of writes) await assert.rejects(fn(), code('forbidden'));
    // Sensitive actions are never implied by the engine wildcard.
    const wildcard = ctxOf({ capabilities: [...caps('workspace:read', 'workspace:write', 'workspace:control', 'workspace:export', 'workspace:events'), 'workspace:*'] });
    await engine.overview(wildcard);
    await assert.rejects(engine.exportAudit(wildcard), code('forbidden'));
    await assert.rejects(engine.events(wildcard), code('forbidden'));
    await assert.rejects(engine.inspectLinked(undefined as unknown as kit.ServiceContext, 'E07:claim:c1'), code('unauthenticated'));
  });
});

test('tenant and project isolation through every method', needsPg, async () => {
  await world(async (w, engine) => {
    const view = await engine.createView(ctxOf(), { name: 'Transfer board', pins: [{ ref: 'E07:claim:c1' }], sharedRoles: ['editor'], notes: 'ledger notes' });
    const note = await engine.annotate(ctxOf(), { ref: 'E07:claim:c1', body: 'ledger annotation' });
    await engine.invokeControl(ctxOf(), 'E00:task:t1', 'task.pause');
    await engine.exportAudit(ctxOf(), {});
    for (const other of [ctxOf({ tenantId: 't2' }), ctxOf({ projectId: 'p2' })]) {
      for (const fn of [
        () => engine.inspectLinked(other, 'E07:claim:c1'), () => engine.inspectOne(other, 'E07:claim:c1'), () => engine.getView(other, view.id), () => engine.resolveView(other, view.id),
        () => engine.listViewRevisions(other, view.id), () => engine.updateView(other, view.id, { expectedRevision: 1, name: 'stolen' }), () => engine.archiveView(other, view.id, { expectedRevision: 1 }),
        () => engine.acknowledgeViewFlags(other, view.id), () => engine.resolveAnnotation(other, note.id), () => engine.listControls(other, 'E00:task:t1'), () => engine.invokeControl(other, 'E00:task:t1', 'task.resume'),
        () => engine.listAnnotations(other, { ref: 'E07:claim:c1' }), () => engine.annotate(other, { ref: 'E07:claim:c1', body: 'x' }), () => engine.listControlInvocations(other, { ref: 'E00:task:t1' }),
      ]) await assert.rejects(fn(), code('not_found'));
      assert.equal(await engine.inspect(other, view.ref), null);
      assert.equal(await engine.inspect(other, note.ref), null);
      assert.deepEqual(await engine.listViews(other, { includeArchived: true }), []);
      assert.deepEqual(await engine.search(other, { q: 'ledger' }), []);
      assert.deepEqual((await engine.listAnnotations(other)).annotations, []);
      assert.deepEqual(await engine.listControlInvocations(other), []);
      const found = await engine.searchAll(other, { q: 'ledger' });
      assert.deepEqual(found.groups.flatMap((g) => g.hits).map((h) => h.title), [other.tenantId === 't2' ? 'Other tenant ledger' : 'Other project ledger'], 'only that scope\'s own record');
      const timeline = await engine.auditTimeline(other);
      assert.ok(timeline.records.every((r) => r.subject !== 'E07:claim:c1' && !r.subject.includes(view.id)));
      assert.equal(timeline.records.filter((r) => r.engine === 'E14').length, 0);
      assert.equal(timeline.records.length, 1, 'only that scope\'s own seed record');
      assert.deepEqual(await engine.audit(other), []);
      const exported = await engine.exportAudit(other, { format: 'json' });
      assert.equal(exported.recordCount, 1);
      assert.ok(!exported.content.includes(view.id) && !exported.content.includes('"t1"') === (other.tenantId === 't2'));
      assert.deepEqual((await engine.applyUpstreamChange(other, { eventId: 'evt-x', kind: 'source_corrected', refs: ['E07:claim:c1'], reason: 'r' })).affected, []);
    }
    assert.equal((await engine.getView(ctxOf(), view.id)).stale, false, 'a change applied in another scope does not flag this view');
    assert.equal((await engine.events(ctxOf({ tenantId: 't2' }))).filter((e) => e.type !== 'audit.exported').length, 0);
    // A port that wrongly returns foreign audit records is filtered as defence in depth.
    const leaky = createEngine({ sql: w.sql, ports: { engines: { E05: { ...w.e05, inspect: w.e05.inspect, search: w.e05.search, health: w.e05.health, manifest: w.e05.manifest, audit: () => kit.listAudit(w.sql, w.e05.schema, { tenantId: 't2', projectId: 'p1' }) } } } });
    assert.equal((await leaky.auditTimeline(ctxOf(), { engines: ['E05'] })).records.length, 0);
  });
});

test('object view: normalised inspection with badges, links and annotations; search fan-out; overview', needsPg, async () => {
  await world(async (w, engine) => {
    await engine.annotate(ctxOf(), { ref: 'E09:scene:s1', kind: 'review', body: 'Needs a new permission' });
    const scene = await engine.inspectOne(ctxOf(), 'E09:scene:s1');
    assert.deepEqual([scene.ref, scene.engine, scene.engineName, scene.kind, scene.title, scene.state, scene.engineState], ['E09:scene:s1@1', 'E09', 'Test editorial', 'scene', 'Scene one', 'blocked', 'active']);
    assert.deepEqual(scene.badges.map((b) => b.label), ['Blocked']);
    assert.deepEqual(scene.sources, [{ ref: 'E08:finding:f1', engine: 'E08', kind: 'finding', id: 'f1', revision: null }, { ref: 'E11:permission:p1', engine: 'E11', kind: 'permission', id: 'p1', revision: null }]);
    assert.deepEqual([scene.versions.length, scene.permissions.length, scene.history.length, scene.annotations.length], [1, 1, 1, 1]);
    assert.equal(scene.annotations[0]!.body, 'Needs a new permission');
    assert.deepEqual((await engine.inspectOne(ctxOf(), 'E07:claim:c2')).badges.map((b) => b.state), ['stale']);
    assert.deepEqual((await engine.inspectOne(ctxOf(), 'E00:task:t3')).badges.map((b) => b.state), ['failed']);
    await assert.rejects(engine.inspectOne(ctxOf(), 'E06:derivative:d1'), (e: unknown) => code('unavailable')(e) && !(e as Error).message.includes('connection refused'));
    await assert.rejects(engine.inspectOne(ctxOf(), 'E11:permission:p1'), code('unavailable'));

    const found = await engine.searchAll(ctxOf({ capabilities: caps('knowledge:read') }), { q: 'transfer' });
    assert.deepEqual(found.groups.map((g) => [g.engine, g.status, g.hits.length]), [['E00', 'ok', 0], ['E05', 'ok', 0], ['E06', 'unavailable', 0], ['E07', 'forbidden', 0], ['E08', 'ok', 1], ['E09', 'ok', 0], ['E14', 'ok', 0]]);
    assert.equal(found.groups.find((g) => g.engine === 'E06')!.reason, 'timeout');
    const limited = await engine.searchAll(ctxOf(), { q: 'e', engines: ['E07', 'E11'], limit: 2 });
    assert.deepEqual(limited.groups.map((g) => [g.engine, g.status, g.hits.length, g.reason]), [['E07', 'ok', 2, undefined], ['E11', 'unavailable', 0, 'not_connected']]);
    await assert.rejects(engine.searchAll(ctxOf(), { q: '  ' }), code('invalid_input'));
    await assert.rejects(engine.searchAll(ctxOf(), { q: 'x', engines: ['nope'] }), code('invalid_input'));
    // The caller's own context reaches the engines; nothing is elevated.
    const last = w.e08.calls.at(-1)!;
    assert.deepEqual([last.method, last.actorId, last.tenantId], ['search', 'ana', 't1']);
    assert.ok(w.e07.calls.every((c) => c.actorId === 'ana' || c.actorId === 'seed'));

    const overview = await engine.overview(ctxOf());
    const cards = Object.fromEntries(overview.engines.map((e) => [e.engine, e]));
    assert.deepEqual(overview.engines.map((e) => [e.engine, e.status]), [['E00', 'ok'], ['E05', 'ok'], ['E06', 'unavailable'], ['E07', 'ok'], ['E08', 'ok'], ['E09', 'ok'], ['E14', 'ok']]);
    assert.deepEqual(cards.E07!.counts, { things: 4 }, 'counts are exactly what the engine health reports');
    assert.deepEqual(cards.E06!.counts, {});
    assert.deepEqual((await engine.listEngines(ctxOf())).filter((e) => e.controls).map((e) => e.engine), ['E00', 'E14']);
  });
});

test('audit timeline: merged ordering, per-engine status, chain verification, paging and export', needsPg, async () => {
  await world(async (w, engine) => {
    const view = await engine.createView(ctxOf(), { name: 'Audit board' });
    await engine.annotate(ctxOf(), { ref: 'E07:claim:c1', body: 'private remark text' });
    const all = await engine.auditTimeline(ctxOf());
    assert.equal(all.order, 'asc');
    const times = all.records.map((r) => Date.parse(r.at));
    assert.deepEqual(times, [...times].sort((a, b) => a - b), 'merged records are in time order');
    assert.deepEqual(Object.fromEntries(all.engines.map((e) => [e.engine, [e.status, e.count, e.chain]])), {
      E00: ['ok', 3, 'verified'], E05: ['ok', 2, 'verified'], E06: ['unavailable', 0, 'not_checked'], E07: ['ok', 4, 'verified'], E08: ['ok', 1, 'verified'], E09: ['ok', 1, 'verified'], E14: ['ok', 2, 'verified'],
    });
    assert.equal(all.truncated, false);
    assert.deepEqual(Object.keys(all.records[0]!).sort(), ['action', 'actorId', 'actorKind', 'at', 'detail', 'engine', 'hash', 'id', 'projectId', 'purpose', 'requestId', 'subject', 'tenantSeq']);
    assert.ok(all.records.some((r) => r.engine === 'E14' && r.action === 'view.created' && r.subject === `E14:view:${view.id}` && r.actorId === 'ana'));
    assert.ok(!JSON.stringify(all).includes('private remark text'), 'annotation text is not written to the audit trail');

    // Paging with cursors returns every record exactly once, in the same order.
    const paged: string[] = [];
    let cursors: Record<string, string> = {};
    for (let i = 0; i < 20; i++) {
      const page = await engine.auditTimeline(ctxOf(), { limit: 4, cursors, verifyChains: false });
      paged.push(...page.records.map((r) => `${r.engine}:${r.id}`));
      cursors = page.cursors;
      if (!page.truncated) break;
      assert.equal(page.records.length, 4);
    }
    assert.deepEqual(paged, all.records.map((r) => `${r.engine}:${r.id}`));
    const newest = await engine.auditTimeline(ctxOf(), { order: 'desc', limit: 3 });
    assert.deepEqual(newest.records.map((r) => `${r.engine}:${r.id}`), all.records.slice(-3).reverse().map((r) => `${r.engine}:${r.id}`));
    assert.equal(newest.truncated, true);

    const subject = await engine.auditTimeline(ctxOf(), { subject: 'E07:claim:c1' });
    assert.deepEqual(subject.records.map((r) => [r.engine, r.action]), [['E07', 'thing.saved'], ['E14', 'annotation.created']]);
    const only = await engine.auditTimeline(ctxOf(), { engines: ['E08', 'E11'] });
    assert.deepEqual(only.engines.map((e) => [e.engine, e.status, e.reason]), [['E08', 'ok', undefined], ['E11', 'unavailable', 'not_connected']]);
    const after = await engine.auditTimeline(ctxOf(), { after: all.records[all.records.length - 3]!.at });
    assert.deepEqual(after.records.map((r) => r.id), all.records.slice(-2).map((r) => r.id));
    const forbidden = await engine.auditTimeline(ctxOf({ capabilities: caps('knowledge:read') }));
    assert.deepEqual(forbidden.engines.find((e) => e.engine === 'E07'), { engine: 'E07', name: 'Test knowledge', status: 'forbidden', count: 0, chain: 'not_checked', exhausted: true });
    assert.ok(forbidden.records.every((r) => r.engine !== 'E07'));
    await assert.rejects(engine.auditTimeline(ctxOf(), { after: 'yesterday' }), code('invalid_input'));
    await assert.rejects(engine.auditTimeline(ctxOf(), { cursors: { E05: 'x' } }), code('invalid_input'));

    // Tampering with an engine's audit rows is reported as a broken chain.
    await w.sql.query(`update ${w.e08.schema}._audit set action='thing.rewritten'`);
    assert.equal((await engine.auditTimeline(ctxOf(), { engines: ['E08'] })).engines[0]!.chain, 'broken');

    // Export: exact capability, CSV and JSON, recorded in E14's own audit log.
    const csv = await engine.exportAudit(ctxOf(), { format: 'csv' });
    const rows = csv.content.trimEnd().split('\r\n');
    assert.equal(rows[0], '"at","engine","id","actorId","actorKind","action","subject","requestId","purpose"');
    assert.equal(rows.length - 1, all.records.length); assert.equal(csv.recordCount, all.records.length);
    assert.equal(csv.mediaType, 'text/csv; charset=utf-8'); assert.match(csv.filename, /^audit-2026-01-01-[0-9a-f]{8}\.csv$/);
    assert.equal(csv.sha256, (await import('node:crypto')).createHash('sha256').update(csv.content).digest('hex'));
    const json = await engine.exportAudit(ctxOf(), { format: 'json', subject: 'E07:claim:c1' });
    const parsed = JSON.parse(json.content) as { records: { action: string; detail: unknown }[]; subject: string; exportedBy: string };
    assert.deepEqual([parsed.subject, parsed.exportedBy, parsed.records.length], ['E07:claim:c1', 'ana', 2]);
    assert.ok(parsed.records.every((r) => r.detail === null), 'free-form detail is left out unless asked for');
    assert.ok((JSON.parse((await engine.exportAudit(ctxOf(), { format: 'json', includeDetail: true })).content) as { records: { detail: unknown }[] }).records.some((r) => r.detail !== null));
    const own = await engine.audit(ctxOf());
    const exports = own.filter((a) => a.action === 'audit.exported');
    assert.equal(exports.length, 3);
    assert.deepEqual([(exports[0]!.detail as { sha256: string }).sha256, (exports[0]!.detail as { recordCount: number }).recordCount, exports[1]!.subject], [csv.sha256, csv.recordCount, 'E07:claim:c1']);
    assert.ok(kit.verifyAuditChain(await kit.listAudit(w.sql, 'e14_workspace', ctxOf(), { allProjects: true })));
    await assert.rejects(engine.exportAudit(ctxOf(), { format: 'xml' as 'csv' }), code('invalid_input'));

    // A chain with records this reader cannot see in the middle (another project's) cannot be verified: it is reported as partial.
    // The late record carries an early timestamp: paging by cursor still returns every record exactly once.
    await w.e05.put(ctxOf({ actor: { id: 'seed', kind: 'service', roles: [] }, now: all.records[0]!.at }), { id: 'ev3', kind: 'evidence', title: 'Later scan' });
    assert.equal((await engine.auditTimeline(ctxOf(), { engines: ['E05'] })).engines[0]!.chain, 'partial');
    const whole = (await engine.auditTimeline(ctxOf(), { verifyChains: false })).records.map((r) => `${r.engine}:${r.id}`);
    const again: string[] = [];
    cursors = {};
    for (let i = 0; i < 30; i++) {
      const page = await engine.auditTimeline(ctxOf(), { limit: 3, cursors, verifyChains: false });
      again.push(...page.records.map((r) => `${r.engine}:${r.id}`));
      cursors = page.cursors;
      if (!page.truncated) break;
    }
    assert.deepEqual(again, whole);
    assert.equal(new Set(again).size, again.length);
  });
});

test('controls: listed from host ports, invoked with the caller context, audited, denied without capability', needsPg, async () => {
  await world(async (w, engine) => {
    const listed = await engine.listControls(ctxOf(), 'E00:task:t1');
    assert.deepEqual(listed.controls.map((c) => [c.id, c.source, c.dangerous, c.allowed]), [
      ['task.pause', 'E00', false, true], ['task.resume', 'E00', false, true], ['task.cancel', 'E00', true, true], ['task.reassign', 'E00', false, false],
      ['workspace.review_note', 'E14', false, true], ['workspace.request_correction', 'E14', false, true], ['workspace.export_audit', 'E14', false, true],
    ]);
    assert.equal(listed.controls.find((c) => c.id === 'task.reassign')!.deniedReason, 'Requires orchestration:admin');
    assert.deepEqual((listed.controls.find((c) => c.id === 'task.cancel')!.input as { required: string[] }).required, ['reason']);
    assert.deepEqual((await engine.listControls(ctxOf(), 'E07:claim:c1')).controls.map((c) => c.source), ['E14', 'E14', 'E14'], 'objects without a host port still get the workspace controls');
    const viewer = ctxOf({ capabilities: caps('workspace:control', 'orchestration:write') });
    assert.ok((await engine.listControls(viewer, 'E00:task:t1')).controls.every((c) => !c.allowed && c.deniedReason !== undefined));

    // Pause: the port and the engine receive the caller's own context.
    const paused = await engine.invokeControl(ctxOf({ actor: { id: 'bea', kind: 'human', roles: [] } }), 'E00:task:t1', 'task.pause', {}, { idempotencyKey: 'k1' });
    assert.deepEqual([paused.outcome, paused.result, paused.error, paused.controlId, paused.subject, paused.actorId], ['succeeded', { id: 't1', state: 'paused' }, null, 'task.pause', 'E00:task:t1', 'bea']);
    assert.deepEqual(w.taskControls.invoked.map((i) => [i.controlId, i.actorId]), [['task.pause', 'bea']]);
    assert.deepEqual([w.e00.calls.at(-1)!.method, w.e00.calls.at(-1)!.actorId], ['pause', 'bea']);
    assert.equal((await engine.inspectOne(ctxOf(), 'E00:task:t1')).engineState, 'paused');
    // Replay with the same key returns the recorded outcome without invoking again; a different input conflicts.
    const replay = await engine.invokeControl(ctxOf({ actor: { id: 'bea', kind: 'human', roles: [] } }), 'E00:task:t1', 'task.pause', {}, { idempotencyKey: 'k1' });
    assert.equal(replay.id, paused.id); assert.equal(w.taskControls.invoked.length, 1);
    await assert.rejects(engine.invokeControl(ctxOf({ actor: { id: 'bea', kind: 'human', roles: [] } }), 'E00:task:t1', 'task.resume', {}, { idempotencyKey: 'k1' }), code('idempotency_conflict'));

    // The engine's refusal is the outcome shown: code and message come from the owning engine.
    await assert.rejects(engine.invokeControl(ctxOf(), 'E00:task:t1', 'task.pause'), (e: unknown) => code('invalid_state')(e) && (e as Error).message === 'Task in state paused cannot pause' && typeof (e as { invocationId?: string }).invocationId === 'string');

    // Missing the control's capability: denied before the port is called, and the denial is recorded.
    const weak = ctxOf({ actor: { id: 'cy', kind: 'human', roles: [] }, capabilities: caps('orchestration:write') });
    const calls = w.taskControls.invoked.length;
    await assert.rejects(engine.invokeControl(weak, 'E00:task:t1', 'task.resume'), code('forbidden'));
    await assert.rejects(engine.invokeControl(ctxOf(), 'E00:task:t1', 'task.reassign', { assignee: 'x' }), code('forbidden'));
    assert.equal(w.taskControls.invoked.length, calls);
    // Even if E14 were bypassed, the engine itself refuses the caller: nothing is elevated.
    await assert.rejects(w.taskControls.invoke(weak, 'E00:task:t1', 'task.resume', {}), code('forbidden'));
    w.taskControls.invoked.pop();

    // Dangerous actions need explicit confirmation; inputs are validated against the control's schema.
    await assert.rejects(engine.invokeControl(ctxOf(), 'E00:task:t1', 'task.cancel', { reason: 'duplicate' }), code('confirmation_required'));
    await assert.rejects(engine.invokeControl(ctxOf(), 'E00:task:t1', 'task.cancel', {}, { confirm: true }), code('invalid_input'));
    await assert.rejects(engine.invokeControl(ctxOf(), 'E00:task:t1', 'task.cancel', { reason: 7 }, { confirm: true }), code('invalid_input'));
    assert.equal(w.taskControls.invoked.length, calls);
    const cancelled = await engine.invokeControl(ctxOf(), 'E00:task:t1', 'task.cancel', { reason: 'duplicate' }, { confirm: true });
    assert.deepEqual([cancelled.outcome, cancelled.dangerous, cancelled.result], ['succeeded', true, { id: 't1', state: 'cancelled' }]);

    await assert.rejects(engine.invokeControl(ctxOf(), 'E00:task:t1', 'task.unknown'), code('not_found'));
    await assert.rejects(engine.invokeControl(ctxOf(), 'E07:claim:c1', 'task.pause'), code('not_found'));
    await assert.rejects(engine.invokeControl(ctxOf(), 'E00:task:missing', 'task.pause'), code('not_found'));

    // No answer in time: the outcome is recorded as uncertain, never as failed or succeeded.
    w.taskControls.hang = true;
    await assert.rejects(engine.invokeControl(ctxOf(), 'E00:task:t2', 'task.pause', {}, { idempotencyKey: 'k2' }), code('control_uncertain'));
    w.taskControls.hang = false;
    const uncertain = await engine.invokeControl(ctxOf(), 'E00:task:t2', 'task.pause', {}, { idempotencyKey: 'k2' });
    assert.deepEqual([uncertain.outcome, uncertain.error?.code], ['uncertain', 'timeout']);

    // Workspace controls: review note and correction request become annotations; export returns the file.
    const review = await engine.invokeControl(ctxOf(), 'E07:claim:c1', 'workspace.request_correction', { body: 'Date is wrong' });
    assert.equal((review.result as { kind: string }).kind, 'correction_request');
    assert.deepEqual((await engine.listAnnotations(ctxOf(), { ref: 'E07:claim:c1' })).annotations.map((a) => [a.kind, a.body, a.status]), [['correction_request', 'Date is wrong', 'open']]);
    await assert.rejects(engine.invokeControl(ctxOf(), 'E07:claim:c1', 'workspace.review_note', {}), code('invalid_input'));
    await assert.rejects(engine.invokeControl(ctxOf(), 'E07:claim:c1', 'workspace.review_note', { body: 'x', extra: 1 }), code('invalid_input'));
    const exported = await engine.invokeControl(ctxOf(), 'E00:task:t1', 'workspace.export_audit', { format: 'csv' });
    assert.match((exported.result as { content: string }).content, /"thing\.pause"/);
    await assert.rejects(engine.invokeControl(ctxOf({ capabilities: caps('workspace:export') }), 'E00:task:t1', 'workspace.export_audit', {}), code('forbidden'));

    // E14's own audit log records every attempt and its outcome, without inputs or results.
    const trail = (await engine.audit(ctxOf(), { subject: 'E00:task:t1' })).map((a) => `${a.action}:${(a.detail as { controlId?: string }).controlId ?? ''}:${a.actorId}`);
    assert.deepEqual(trail.filter((t) => t.startsWith('control.')), [
      'control.attempted:task.pause:bea', 'control.succeeded:task.pause:bea', 'control.attempted:task.pause:ana', 'control.failed:task.pause:ana', 'control.denied:task.resume:cy', 'control.denied:task.reassign:ana',
      'control.attempted:task.cancel:ana', 'control.succeeded:task.cancel:ana', 'control.attempted:workspace.export_audit:ana', 'control.succeeded:workspace.export_audit:ana', 'control.denied:workspace.export_audit:ana',
    ]);
    assert.ok(!JSON.stringify(await engine.audit(ctxOf())).includes('duplicate'), 'control inputs are not copied into the audit trail');
    const history = await engine.listControlInvocations(ctxOf(), { ref: 'E00:task:t1' });
    assert.deepEqual(history.map((h) => h.outcome).sort(), ['denied', 'denied', 'denied', 'failed', 'succeeded', 'succeeded', 'succeeded']);
    assert.deepEqual(history.find((h) => h.outcome === 'failed')!.error, { code: 'invalid_state', message: 'Task in state paused cannot pause' });
    const inspected = await engine.inspect(ctxOf(), paused.ref);
    assert.deepEqual([inspected!.kind, inspected!.state, inspected!.sources], ['control_invocation', 'succeeded', ['E00:task:t1']]);
    const events = await poll(() => engine.events(ctxOf()), (list) => list.filter((e) => e.type.startsWith('control.')).length >= 6);
    assert.deepEqual(events.filter((e) => e.type.startsWith('control.')).map((e) => e.type), ['control.succeeded', 'control.failed', 'control.succeeded', 'control.uncertain', 'control.succeeded', 'control.succeeded']);
  });
});

test('controls: errors from an engine with its own DomainError class, malformed specs, unavailable ports', needsPg, async () => {
  await kit.withDisposableDatabase(pg, ADMIN, async (url, sql) => {
    await migrate(sql);
    const w = await buildWorld(sql, url);
    class ForeignDomainError extends Error { readonly code: string; constructor(c: string, m: string) { super(m); this.name = 'DomainError'; this.code = c; } }
    const engine = createEngine({ sql, config: { engineTimeoutMs: 300 }, ports: { engines: w.engines, controls: {
      E07: { controlsFor: async () => [{ id: 'claim.approve', label: 'Approve', capability: 'knowledge:approve', dangerous: false, input: {} }, { id: 'BAD ID', label: 'x', capability: 'knowledge:read', dangerous: false, input: {} },
        { id: 'workspace.spoof', label: 'x', capability: 'knowledge:read', dangerous: false, input: {} }, { id: 'no.flag', label: 'x', capability: 'knowledge:read', input: {} } as never, { id: 'claim.retract', label: 'Retract', capability: 'knowledge:write', dangerous: true, input: {} }],
        invoke: async () => { throw new ForeignDomainError('budget_exhausted', 'Review budget is exhausted'); } },
      E08: { controlsFor: async () => { throw new Error('port down'); }, invoke: async () => null },
      '*': { controlsFor: async () => [{ id: 'host.export', label: 'Export package', capability: 'workspace:export', dangerous: false, input: {} }], invoke: async (_c, ref, id) => ({ ref, id }) },
    } } });
    const claim = await engine.listControls(ctxOf(), 'E07:claim:c1');
    assert.deepEqual(claim.controls.map((c) => [c.id, c.source, c.allowed]), [['claim.approve', 'E07', false], ['claim.retract', 'E07', true], ['host.export', 'host', true], ['workspace.review_note', 'E14', true], ['workspace.request_correction', 'E14', true], ['workspace.export_audit', 'E14', true]]);
    await assert.rejects(engine.invokeControl(ctxOf(), 'E07:claim:c1', 'claim.retract', {}, { confirm: true }), (e: unknown) => e instanceof DomainError && e.code === 'budget_exhausted' && e.message === 'Review budget is exhausted');
    assert.deepEqual((await engine.invokeControl(ctxOf(), 'E07:claim:c1', 'host.export')).result, { ref: 'E07:claim:c1', id: 'host.export' });
    const finding = await engine.listControls(ctxOf(), 'E08:finding:f1');
    assert.equal(finding.unavailable, true);
    assert.deepEqual(finding.controls.map((c) => c.source), ['host', 'E14', 'E14', 'E14']);
    // An object whose engine is down: host controls are still offered, workspace notes are not (visibility unconfirmed).
    const down = await engine.listControls(ctxOf(), 'E06:derivative:d1');
    assert.deepEqual([down.unavailable, down.controls.map((c) => c.id)], [true, ['host.export']]);
    await assert.rejects(engine.invokeControl(ctxOf(), 'E06:derivative:d1', 'workspace.review_note', { body: 'x' }), code('unavailable'));
    validateControlInput({ type: 'object', properties: { n: { type: 'integer' }, f: { type: 'string', enum: ['a', 'b'] } } }, { n: 2, f: 'a' });
    assert.throws(() => validateControlInput({ type: 'object', properties: { n: { type: 'integer' } } }, { n: 1.5 }), code('invalid_input'));
    assert.throws(() => validateControlInput({ type: 'object', properties: { f: { type: 'string', enum: ['a'] } } }, { f: 'z' }), code('invalid_input'));
    assert.throws(() => validateControlInput({ type: 'object', properties: {} }, [] as never), code('invalid_input'));
  });
});

test('saved views: revisions, sharing, stale and blocked flags from upstream changes', needsPg, async () => {
  await world(async (w, engine) => {
    const ana = ctxOf();
    const created = await engine.createView(ana, { name: 'Transfer story', pins: [{ ref: 'E07:claim:c1', label: 'Key claim', x: 10, y: 20 }, { ref: 'E05:evidence:ev1@1' }, { ref: 'E09:scene:s1', note: 'awaiting permission' }], filters: { kinds: ['claim'] }, layout: { mode: 'graph' }, notes: 'Working board', sharedRoles: ['reviewer'], editorRoles: ['lead'], idempotencyKey: 'v1' });
    assert.deepEqual([created.revision, created.ref, created.ownerId, created.stale, created.blocked, created.canEdit], [1, `E14:view:${created.id}@1`, 'ana', false, false, true]);
    assert.equal((await engine.createView(ana, { name: 'Transfer story', pins: [{ ref: 'E07:claim:c1', label: 'Key claim', x: 10, y: 20 }, { ref: 'E05:evidence:ev1@1' }, { ref: 'E09:scene:s1', note: 'awaiting permission' }], filters: { kinds: ['claim'] }, layout: { mode: 'graph' }, notes: 'Working board', sharedRoles: ['reviewer'], editorRoles: ['lead'], idempotencyKey: 'v1' })).id, created.id);
    await assert.rejects(engine.createView(ana, { name: 'Other', idempotencyKey: 'v1' }), code('idempotency_conflict'));
    for (const bad of [{ name: '' }, { name: 'x', pins: [{ ref: 'nope' }] }, { name: 'x', pins: [{ ref: 'E07:claim:c1' }, { ref: 'E07:claim:c1' }] }, { name: 'x', sharedRoles: ['has space'] }, { name: 'x', pins: [{ ref: 'E07:claim:c1', x: Number.NaN }] }, { name: 'x', layout: { big: 'x'.repeat(70_000) } }])
      await assert.rejects(engine.createView(ana, bad as never), (e: unknown) => code('invalid_input')(e) || code('invalid_reference')(e));

    // Sharing: reviewers read, leads edit, strangers see nothing; only the owner changes sharing.
    const reviewer = ctxOf({ actor: { id: 'rev', kind: 'human', roles: ['reviewer'] } }), lead = ctxOf({ actor: { id: 'lea', kind: 'human', roles: ['lead'] } }), stranger = ctxOf({ actor: { id: 'sam', kind: 'human', roles: ['other'] } });
    assert.equal((await engine.getView(reviewer, created.id)).canEdit, false);
    await assert.rejects(engine.updateView(reviewer, created.id, { expectedRevision: 1, name: 'Renamed' }), code('forbidden'));
    await assert.rejects(engine.getView(stranger, created.id), code('not_found'));
    assert.deepEqual(await engine.listViews(stranger), []);
    assert.equal(await engine.inspect(stranger, created.ref), null);
    assert.deepEqual(await engine.search(stranger, { q: 'Transfer' }), []);
    assert.deepEqual((await engine.search(reviewer, { q: 'transfer' })).map((h) => [h.kind, h.title]), [['view', 'Transfer story']]);
    await assert.rejects(engine.updateView(lead, created.id, { expectedRevision: 1, sharedRoles: ['everyone'] }), code('forbidden'));
    const second = await engine.updateView(lead, created.id, { expectedRevision: 1, notes: 'Lead added context', summary: 'Added context', idempotencyKey: 'u1' });
    assert.deepEqual([second.revision, second.notes, second.pins.length], [2, 'Lead added context', 3]);
    assert.equal((await engine.updateView(lead, created.id, { expectedRevision: 1, notes: 'Lead added context', summary: 'Added context', idempotencyKey: 'u1' })).revision, 2);
    await assert.rejects(engine.updateView(ana, created.id, { expectedRevision: 1, name: 'Late' }), code('revision_conflict'));
    const third = await engine.updateView(ana, created.id, { expectedRevision: 2, pins: [{ ref: 'E07:claim:c1' }, { ref: 'E09:scene:s1' }, { ref: 'E06:derivative:d1' }, { ref: 'E05:evidence:ev2' }], name: 'Transfer story v3' });
    assert.deepEqual((await engine.listViewRevisions(reviewer, created.id)).map((r) => [r.revision, r.actorId, r.summary, r.name]), [[1, 'ana', 'Created', 'Transfer story'], [2, 'lea', 'Added context', 'Transfer story'], [3, 'ana', 'Updated', 'Transfer story v3']]);
    const first = await engine.getView(ana, created.id, { revision: 1 });
    assert.deepEqual([first.revision, first.currentRevision, first.notes, first.pins[0]], [1, 3, 'Working board', { ref: 'E07:claim:c1', label: 'Key claim', x: 10, y: 20 }], 'earlier revisions are kept unchanged');
    await assert.rejects(engine.getView(ana, created.id, { revision: 9 }), code('not_found'));

    // Board: every pin shows its live state from the owning engine, with the caller's permissions.
    const board = await engine.resolveView(ctxOf({ compartments: [] }), created.id);
    assert.deepEqual(board.pins.map((p) => [p.ref, p.state, p.title]), [['E07:claim:c1', 'ok', 'Ledger shows a transfer'], ['E09:scene:s1', 'blocked', 'Scene one'], ['E06:derivative:d1', 'unavailable', ''], ['E05:evidence:ev2', 'forbidden_or_missing', '']]);
    assert.deepEqual(board.unavailableEngines, ['E06']);

    // An upstream correction: the knowledge engine marks its claim stale, E14 flags the view that pins it.
    const service = ctxOf({ actor: { id: 'router', kind: 'service', roles: [] } });
    await w.e07.applyUpstreamChange(service, { eventId: 'evt-1', kind: 'source_corrected', refs: ['E05:evidence:ev1@1'], reason: 'Scan replaced with a corrected page' });
    const change = { eventId: 'evt-2', kind: 'claim_changed' as const, refs: ['E07:claim:c1@1', 'E08:finding:zz'], reason: 'Claim is stale after a source correction' };
    const applied = await engine.applyUpstreamChange(service, change);
    assert.deepEqual(applied.affected, [`E14:view:${created.id}@3`]);
    assert.deepEqual(await engine.applyUpstreamChange(service, change), applied, 'idempotent by eventId');
    const flagged = await engine.getView(ana, created.id);
    assert.deepEqual([flagged.stale, flagged.blocked, flagged.revision], [true, false, 3], 'flagging does not rewrite the view');
    assert.deepEqual(flagged.flags.map((f) => [f.ref, f.effect, f.reason, f.changeKind, f.causeEventId, f.causeRef]), [['E07:claim:c1', 'stale', 'Claim is stale after a source correction', 'claim_changed', 'evt-2', 'E07:claim:c1@1']]);
    assert.deepEqual((await engine.applyUpstreamChange(service, { eventId: 'evt-3', kind: 'permission_withdrawn', refs: ['E09:scene:s1'], reason: 'Participant withdrew consent' })).affected, [`E14:view:${created.id}@3`]);
    const both = await engine.getView(reviewer, created.id);
    assert.deepEqual([both.stale, both.blocked, both.flags.length], [true, true, 2]);
    assert.equal((await engine.listViews(ana))[0]!.stale, true);
    const inspected = (await engine.inspect(ana, `E14:view:${created.id}`))!;
    assert.deepEqual([inspected.stale, inspected.blocked, inspected.state, inspected.versions.length, inspected.sources.length], [true, true, 'active', 3, 4]);
    assert.deepEqual(inspected.staleReasons, ['E07:claim:c1: Claim is stale after a source correction', 'E09:scene:s1: Participant withdrew consent']);
    assert.ok(inspected.history.some((h) => h.action === 'view.stale') && inspected.history.some((h) => h.action === 'view.blocked'));
    const linked = await engine.inspectLinked(ana, `E14:view:${created.id}`, { depth: 1 });
    assert.deepEqual([linked.nodes[0]!.state, linked.nodes.find((n) => n.ref === 'E07:claim:c1@1')!.state], ['blocked', 'stale'], 'the view and the claim both show the propagated state');
    const pinBoard = await engine.resolveView(ana, created.id);
    assert.deepEqual(pinBoard.pins.map((p) => [p.state, p.flags.length]), [['stale', 1], ['blocked', 1], ['unavailable', 0], ['ok', 0]]);
    const events = await poll(() => engine.events(service), (list) => list.some((e) => e.type === 'view.blocked'));
    assert.deepEqual(events.filter((e) => e.type === 'view.stale' || e.type === 'view.blocked').map((e) => [e.type, e.subject, e.payload]), [
      ['view.stale', `E14:view:${created.id}@3`, { reason: 'Claim is stale after a source correction', cause: 'evt-2', refs: ['E07:claim:c1'] }],
      ['view.blocked', `E14:view:${created.id}@3`, { reason: 'Participant withdrew consent', cause: 'evt-3', refs: ['E09:scene:s1'] }]]);
    assert.ok(events.every((e) => e.engine === 'E14'));

    // Acknowledging keeps the record of the flag; unpinning removes it from the current state.
    await assert.rejects(engine.acknowledgeViewFlags(reviewer, created.id), code('forbidden'));
    const acked = await engine.acknowledgeViewFlags(lead, created.id, { refs: ['E07:claim:c1'], note: 'Reviewed the corrected claim' });
    assert.deepEqual([acked.stale, acked.blocked, acked.flags.length], [false, true, 1]);
    assert.deepEqual((await engine.inspect(ana, created.ref))!.decisions, [{ type: 'flag_acknowledged', ref: 'E07:claim:c1', by: 'lea', at: (await engine.inspect(ana, created.ref))!.decisions[0] === undefined ? '' : ((await engine.inspect(ana, created.ref))!.decisions[0] as { at: string }).at, cause: 'evt-2' }]);
    const unpinned = await engine.updateView(ana, created.id, { expectedRevision: 3, pins: [{ ref: 'E07:claim:c1' }] });
    assert.deepEqual([unpinned.blocked, unpinned.flags.length], [false, 0]);
    // Archived views are not flagged; restoring keeps history.
    const archived = await engine.archiveView(ana, created.id, { expectedRevision: 4 });
    assert.equal(archived.archived, true);
    assert.deepEqual(await engine.listViews(ana), []);
    assert.equal((await engine.listViews(ana, { includeArchived: true })).length, 1);
    assert.deepEqual((await engine.applyUpstreamChange(service, { eventId: 'evt-4', kind: 'claim_changed', refs: ['E07:claim:c1'], reason: 'again' })).affected, []);
    assert.equal((await engine.archiveView(ana, created.id, { expectedRevision: 5, archived: false })).archived, false);
    for (const bad of [{ eventId: '', kind: 'claim_changed', refs: [], reason: '' }, { eventId: 'x', kind: 'nope', refs: [], reason: '' }, { eventId: 'x', kind: 'claim_changed', refs: ['bad'], reason: '' }])
      await assert.rejects(engine.applyUpstreamChange(service, bad as never), (e: unknown) => code('invalid_input')(e) || code('invalid_reference')(e));
  });
});

test('annotations: only on visible objects, listed only to those who can see the subject, resolved once', needsPg, async () => {
  await world(async (_w, engine) => {
    const outsider = ctxOf({ compartments: [], actor: { id: 'out', kind: 'human', roles: [] } });
    const sealed = await engine.annotate(ctxOf(), { ref: 'E05:evidence:ev2', kind: 'flag', body: 'Sealed remark', idempotencyKey: 'a1' });
    assert.equal((await engine.annotate(ctxOf(), { ref: 'E05:evidence:ev2', kind: 'flag', body: 'Sealed remark', idempotencyKey: 'a1' })).id, sealed.id);
    const open = await engine.annotate(ctxOf(), { ref: 'E07:claim:c1@1', body: 'Open remark' });
    assert.deepEqual([open.kind, open.status, open.authorId, open.subject, open.ref], ['note', 'open', 'ana', 'E07:claim:c1@1', `E14:annotation:${open.id}`]);
    await assert.rejects(engine.annotate(outsider, { ref: 'E05:evidence:ev2', body: 'x' }), code('not_found'));
    await assert.rejects(engine.annotate(ctxOf(), { ref: 'E05:evidence:nope', body: 'x' }), code('not_found'));
    await assert.rejects(engine.annotate(ctxOf(), { ref: 'E06:derivative:d1', body: 'x' }), code('unavailable'));
    await assert.rejects(engine.annotate(ctxOf(), { ref: 'E07:claim:c1', body: '' }), code('invalid_input'));
    await assert.rejects(engine.annotate(ctxOf(), { ref: 'E07:claim:c1', body: 'x', kind: 'rumour' as never }), code('invalid_input'));

    assert.deepEqual((await engine.listAnnotations(ctxOf())).annotations.map((a) => a.body).sort(), ['Open remark', 'Sealed remark']);
    assert.deepEqual((await engine.listAnnotations(outsider)).annotations.map((a) => a.body), ['Open remark']);
    assert.deepEqual((await engine.search(outsider, { q: 'remark' })).map((h) => h.snippet), ['Open remark']);
    assert.equal(await engine.inspect(outsider, sealed.ref), null);
    await assert.rejects(engine.resolveAnnotation(outsider, sealed.id), code('not_found'));
    // Annotations follow the object across revisions.
    assert.deepEqual((await engine.inspectOne(ctxOf(), 'E07:claim:c1')).annotations.map((a) => a.body), ['Open remark']);
    const resolved = await engine.resolveAnnotation(ctxOf({ actor: { id: 'bea', kind: 'human', roles: [] } }), open.id, { resolution: 'Checked' });
    assert.deepEqual([resolved.status, resolved.resolvedBy, resolved.resolution], ['resolved', 'bea', 'Checked']);
    await assert.rejects(engine.resolveAnnotation(ctxOf(), open.id), code('invalid_state'));
    await assert.rejects(engine.resolveAnnotation(ctxOf(), 'not-an-id'), code('not_found'));
    assert.deepEqual((await engine.listAnnotations(ctxOf(), { status: 'open' })).annotations.map((a) => a.body), ['Sealed remark']);
    const inspected = (await engine.inspect(ctxOf(), open.ref))!;
    assert.deepEqual([inspected.kind, inspected.state, inspected.sources, inspected.decisions.length], ['annotation', 'resolved', ['E07:claim:c1@1'], 1]);
    assert.deepEqual((await engine.audit(ctxOf())).map((a) => a.action), ['annotation.created', 'annotation.created', 'annotation.resolved']);
  });
});
