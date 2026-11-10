// Browser tests for the component library: real Chromium via Playwright, keyboard only where stated, axe-core scans.
// Run with `npm run test:browser`. Playwright and Chromium come from the environment; they are not project dependencies.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import fixtures from '../../web/fixtures.js';
import { edgeKey } from '../../web/model.js';

const require = createRequire(import.meta.url);
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* reported as a visible skip below */ }
const skip = chromium === null ? { skip: 'playwright is not installed in this environment; browser tests not executed' } : {};
const WEB = fileURLToPath(new URL('../../web/', import.meta.url));
const AXE = await readFile(require.resolve('axe-core/axe.min.js'), 'utf8');
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
let server, browser, base;

before(async () => {
  if (chromium === null) return;
  server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^[/\\]+/, '');
    try {
      if (path.includes('..') || TYPES[extname(path)] === undefined) throw new Error('no');
      const body = await readFile(join(WEB, path));
      res.writeHead(200, { 'content-type': `${TYPES[extname(path)]}; charset=utf-8`, 'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self' 'unsafe-eval'" }); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (server) await new Promise((r) => server.close(r)); });

async function open(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...options });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(String(e)));
  await page.goto(`${base}/demo.html`);
  await page.waitForSelector('#graph [data-ref]');
  return { page, context, problems };
}
/** Presses Tab until the focused element matches; fails if it is never reached. Keyboard only. */
async function tabTo(page, selector, max = 400) {
  for (let i = 0; i < max; i++) {
    if (await page.evaluate((sel) => document.activeElement !== null && document.activeElement.matches(sel), selector)) return;
    await page.keyboard.press('Tab');
  }
  assert.fail(`Tab never reached ${selector}`);
}
const focused = (page, attr) => page.evaluate((a) => document.activeElement?.getAttribute(a) ?? null, attr);
async function axe(page, label) {
  await page.evaluate(AXE);
  const result = await page.evaluate(async () => await window.axe.run(document, { resultTypes: ['violations'] }));
  const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  assert.deepEqual(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`), [], `axe serious/critical violations (${label})`);
  return result.violations.length;
}
const strip = (ref) => ref.replace(/@\d+$/, '');
const rootGraph = fixtures.linked[strip(fixtures.start)];
const expectedEdges = [...new Set(rootGraph.edges.map(edgeKey))].sort();

test('demo renders recorded data without errors; stale, blocked, failed and unavailable are visible as text', skip, async () => {
  const { page, context, problems } = await open();
  try {
    assert.equal(await page.locator('#graph [data-ref]').count(), rootGraph.nodes.length);
    const graphText = await page.locator('#graph svg').textContent();
    assert.match(graphText, /Blocked/); assert.match(graphText, /Unavailable/); assert.match(graphText, /Not found or not permitted/); assert.match(graphText, /OK/);
    assert.match(await page.locator('#graph [data-notice="unavailable"]').innerText(), /Unavailable engines \(state unknown\): E06/);
    // The failed task and the stale claim are shown in words on the board and in the inspector.
    assert.match(await page.locator('#board [data-column="failed"]').innerText(), /Render preview[\s\S]*Failed[\s\S]*Engine state: failed/);
    await page.evaluate(() => window.workspaceDemo.navigate('E07:claim:c2'));
    assert.match(await page.locator('#inspector [data-field="state"]').innerText(), /Stale\s*\(source corrected\)/);
    assert.match(await page.locator('#inspector [data-notice="reasons"]').innerText(), /source corrected/);
    await page.evaluate(() => window.workspaceDemo.navigate('E06:derivative:d1'));
    assert.match(await page.locator('#inspector').innerText(), /Disconnected[\s\S]*Engine E06 is unavailable/);
    await page.evaluate(() => window.workspaceDemo.navigate('E05:evidence:ev2'));
    assert.match(await page.locator('#inspector').innerText(), /Not found or not permitted/);
    assert.match(await page.locator('#overview').innerText(), /Test broken engine\s+E06\s+Unavailable/);
    assert.match(await page.locator('#timeline').innerText(), /hash chain verified/);
    assert.match(await page.locator('#timeline').innerText(), /E06\): unavailable/);
    // State never depends on colour alone: every badge has a text label and a shape icon.
    for (const b of await page.locator('.ws-badge').all()) { assert.ok((await b.locator('.ws-badge__label').innerText()).trim().length > 0); assert.equal(await b.locator('svg').count(), 1); }
    // No decorative motion anywhere.
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('*')].filter((el) => { const st = getComputedStyle(el); return st.animationName !== 'none' || (st.transitionDuration !== '0s' && st.transitionDuration !== ''); }).length), 0);
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test('keyboard only: traverse the graph along edges, select a node, walk the inspector tabs, follow a source link', skip, async () => {
  const { page, context, problems } = await open();
  try {
    await tabTo(page, '#graph [data-ref]');
    assert.equal(await focused(page, 'data-ref'), 'E08:finding:f1@1', 'the root is the single tab stop of the graph');
    assert.match(await focused(page, 'aria-label'), /Finding on the transfer \[E08 finding\] - OK - E08:finding:f1@1\. 2 sources, 2 dependents\. Root of this view\. Selected\./);
    await page.keyboard.press('ArrowLeft');
    const source = await focused(page, 'data-ref');
    assert.ok(['E07:claim:c1@1', 'E06:derivative:d1'].includes(source));
    const other = source === 'E07:claim:c1@1' ? 'E06:derivative:d1' : 'E07:claim:c1@1';
    await page.keyboard.press('ArrowDown');
    if (await focused(page, 'data-ref') === source) await page.keyboard.press('ArrowUp');
    assert.equal(await focused(page, 'data-ref'), other, 'up/down moves within the column');
    await page.keyboard.press('Home');
    assert.equal(await focused(page, 'data-ref'), 'E08:finding:f1@1');
    await page.keyboard.press('ArrowRight');
    const dependent = await focused(page, 'data-ref');
    assert.ok(['E09:scene:s1@1', 'E00:task:t1@1'].includes(dependent));
    await page.keyboard.press('ArrowLeft');
    assert.equal(await focused(page, 'data-ref'), 'E08:finding:f1@1', 'left follows the edge back to the source');
    // Walk to the claim and select it with Enter: the inspector shows it, focus stays in the graph.
    await page.keyboard.press('ArrowLeft');
    if (await focused(page, 'data-ref') !== 'E07:claim:c1@1') await page.keyboard.press('ArrowDown');
    if (await focused(page, 'data-ref') !== 'E07:claim:c1@1') { await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); }
    assert.equal(await focused(page, 'data-ref'), 'E07:claim:c1@1');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#inspector .ws-inspector__title').innerText(), 'Ledger shows a transfer');
    assert.equal(await focused(page, 'data-ref'), 'E07:claim:c1@1');
    assert.equal(await focused(page, 'aria-pressed'), 'true');
    assert.equal(await page.locator('#graph [data-ref][tabindex="0"]').count(), 1, 'roving tabindex keeps one tab stop');
    await page.keyboard.press('+'); await page.keyboard.press('-'); await page.keyboard.press('0');
    assert.equal(await focused(page, 'data-ref'), 'E07:claim:c1@1', 'zoom keys keep focus');

    // Inspector tabs: proper tablist semantics, arrow keys, Home and End.
    await tabTo(page, '#inspector [role="tab"]');
    assert.deepEqual([await focused(page, 'data-tab'), await focused(page, 'aria-selected')], ['summary', 'true']);
    assert.equal(await page.locator('#inspector [role="tablist"] [role="tab"]').count(), 8);
    assert.equal(await page.locator('#inspector [role="tab"][tabindex="0"]').count(), 1);
    await page.keyboard.press('ArrowRight');
    assert.deepEqual([await focused(page, 'data-tab'), await focused(page, 'aria-selected')], ['sources', 'true']);
    const panel = page.locator('#inspector [role="tabpanel"]');
    assert.equal(await panel.getAttribute('aria-labelledby'), await focused(page, 'id'));
    assert.match(await panel.innerText(), /E05:evidence:ev1@1[\s\S]*E05:evidence:ev2/);
    const seen = [];
    for (let i = 0; i < 7; i++) { await page.keyboard.press('ArrowRight'); seen.push(await focused(page, 'data-tab')); }
    assert.deepEqual(seen, ['dependents', 'versions', 'permissions', 'decisions', 'history', 'raw', 'summary'], 'arrow keys wrap around every tab');
    await page.keyboard.press('End'); assert.equal(await focused(page, 'data-tab'), 'raw');
    assert.match(await panel.innerText(), /"ref": "E07:claim:c1@1"/);
    await page.keyboard.press('ArrowLeft'); assert.equal(await focused(page, 'data-tab'), 'history');
    assert.match(await panel.innerText(), /thing\.saved/);
    await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
    // Tab into the panel and activate the first source link with Enter: every reference is a navigation control.
    await tabTo(page, '#inspector [role="tabpanel"] button[data-ref]');
    assert.equal(await focused(page, 'data-ref'), 'E05:evidence:ev1@1');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#inspector .ws-inspector__title').innerText(), 'Harbour ledger scan');
    assert.equal(await page.locator('#graph [data-ref]').first().getAttribute('data-ref'), 'E05:evidence:ev1@1', 'the linked view is re-centred on the object');
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test('table and text equivalents contain exactly the relationships of the graph', skip, async () => {
  const { page, context, problems } = await open();
  try {
    const drawn = await page.locator('#graph path[data-edge]').evaluateAll((els) => els.map((e) => e.getAttribute('data-edge')).sort());
    assert.deepEqual(drawn, expectedEdges);
    // Switch with the keyboard; focus stays on the toggle.
    await tabTo(page, '#graph [data-view="table"]');
    await page.keyboard.press('Enter');
    assert.deepEqual([await focused(page, 'data-view'), await focused(page, 'aria-pressed')], ['table', 'true']);
    const table = page.locator('#graph table');
    assert.match(await table.locator('caption').innerText(), /Relationships of Finding on the transfer: 8 objects, 7 links/);
    assert.equal(await table.locator('thead th[scope="col"]').count(), 8);
    const rows = await table.locator('tbody tr').evaluateAll((trs) => trs.map((tr) => ({ header: tr.querySelector('th[scope="row"]')?.textContent, cells: [...tr.children].map((c) => c.textContent), ref: tr.querySelector('[data-ref]')?.getAttribute('data-ref') })));
    assert.equal(rows.length, rootGraph.table.rows.length);
    assert.ok(rows.every((r) => typeof r.header === 'string'), 'every row has a row header');
    const title = new Map(rootGraph.nodes.map((n) => [n.ref, n.title || '(title not available)']));
    const fromTitle = (t) => [...title].find(([, v]) => v === t)?.[0];
    const tableEdges = rows.filter((r) => r.cells[1] !== 'selected object').map((r) => edgeKey({ from: fromTitle(r.cells[0]), to: r.ref, relation: r.cells[1].includes('source') ? 'source' : 'dependent' })).sort();
    assert.deepEqual(tableEdges, expectedEdges);
    assert.deepEqual(rows.map((r) => r.ref).sort(), rootGraph.nodes.map((n) => n.ref).sort());
    assert.ok(rows.some((r) => r.cells.includes('Blocked') && r.cells.includes('permission withdrawn')));
    assert.ok(rows.some((r) => r.cells.includes('Unavailable')));
    // Sorting by keyboard announces the order.
    await tabTo(page, '#graph [data-sort-key="toEngine"]');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#graph th[aria-sort="ascending"]').innerText().then((t) => t.includes('Engine')), true);
    assert.equal(await focused(page, 'data-sort-key'), 'toEngine');
    const engines = await table.locator('tbody tr td:nth-child(4)').allInnerTexts();
    assert.deepEqual(engines, [...engines].sort());
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#graph th[aria-sort="descending"]').count(), 1);
    // Arrow keys move between rows from a reference link.
    await tabTo(page, '#graph tbody button[data-ref]');
    const first = await focused(page, 'data-ref');
    await page.keyboard.press('ArrowDown');
    assert.notEqual(await focused(page, 'data-ref'), first);
    await page.keyboard.press('ArrowUp');
    assert.equal(await focused(page, 'data-ref'), first);

    await page.locator('#graph [data-view="text"]').focus();
    await page.keyboard.press('Enter');
    const items = await page.locator('#graph .ws-outline li').evaluateAll((lis) => lis.map((li) => ({ relation: li.dataset.relation, ref: li.querySelector(':scope > button[data-ref]')?.getAttribute('data-ref') ?? null, parent: li.parentElement.closest('li')?.querySelector(':scope > button[data-ref]')?.getAttribute('data-ref') ?? null, level: Number(li.dataset.level) })));
    const rootItem = items.find((i) => i.relation === 'root');
    assert.equal(rootItem.ref, rootGraph.root);
    const parentOf = (i) => (i.level === 2 ? rootGraph.root : i.parent);
    const outlineEdges = [...new Set(items.filter((i) => i.relation === 'source' || i.relation === 'dependent').map((i) => edgeKey({ from: parentOf(i), to: i.ref, relation: i.relation })))].sort();
    assert.deepEqual(outlineEdges, expectedEdges);
    assert.deepEqual([...new Set(items.filter((i) => i.ref).map((i) => i.ref))].sort(), rootGraph.nodes.map((n) => n.ref).sort());
    assert.equal(await page.locator('#graph .ws-outline__plain pre').textContent(), rootGraph.outline.text, 'the plain text is the service outline, unchanged');
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test('controls: dangerous action needs confirmation in a focus-trapped dialog; real outcome and real error are shown', skip, async () => {
  const { page, context, problems } = await open();
  try {
    await page.evaluate(() => window.workspaceDemo.navigate('E00:task:t1'));
    const bar = page.locator('#controls');
    assert.equal(await bar.locator('[data-control="task.reassign"]').getAttribute('aria-disabled'), 'true');
    assert.match(await bar.innerText(), /Reassign: not available to you\. Requires orchestration:admin/);
    await tabTo(page, '#controls [data-control="task.cancel"]');
    assert.equal(await focused(page, 'aria-haspopup'), 'dialog');
    await page.keyboard.press('Enter');
    const dialog = page.locator('#controls [role="dialog"]');
    assert.equal(await dialog.getAttribute('aria-modal'), 'true');
    assert.equal(await page.locator(`#${await dialog.getAttribute('aria-labelledby')}`).innerText(), 'Confirm: Cancel?');
    assert.match(await dialog.innerText(), /E00:task:t1[\s\S]*marked as dangerous by E00/);
    assert.equal(await bar.locator('[data-outcome]').getAttribute('data-outcome'), 'none', 'nothing was sent yet');
    // Focus starts inside and Tab / Shift+Tab never leave the dialog.
    assert.equal(await page.evaluate(() => document.activeElement.closest('[role="dialog"]') !== null), true);
    const stops = new Set();
    for (let i = 0; i < 8; i++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.closest('[role="dialog"]') !== null), true); stops.add(await page.evaluate(() => document.activeElement.getAttribute('data-dialog') ?? document.activeElement.name)); }
    for (let i = 0; i < 4; i++) { await page.keyboard.press('Shift+Tab'); assert.equal(await page.evaluate(() => document.activeElement.closest('[role="dialog"]') !== null), true); }
    assert.deepEqual([...stops].sort(), ['cancel', 'confirm', 'reason']);
    // Escape closes without sending and returns focus to the button.
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0);
    assert.equal(await focused(page, 'data-control'), 'task.cancel');
    assert.equal(await bar.locator('[data-outcome]').getAttribute('data-outcome'), 'none');
    // Required input is enforced; then confirm sends and the engine's recorded answer is shown.
    await page.keyboard.press('Enter');
    await tabTo(page, '#controls [data-dialog="confirm"]');
    await page.keyboard.press('Enter');
    assert.match(await dialog.locator('[data-problem]').innerText(), /Please fill in: reason/);
    assert.equal(await focused(page, 'name'), 'reason');
    await page.keyboard.type('Duplicate of another task');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#controls [data-outcome="ok"]');
    assert.equal(await bar.locator('[data-outcome]').innerText(), 'Cancel: succeeded. New state: cancelled.');
    assert.equal(await dialog.count(), 0);
    assert.equal(await focused(page, 'data-control'), 'task.cancel');

    // A refusal by the engine is shown with its code and message, as an alert.
    await page.evaluate(() => window.workspaceDemo.navigate('E00:task:t3'));
    await page.locator('#controls [data-control="task.resume"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('#controls [data-outcome="error"]');
    const outcome = bar.locator('[data-outcome]');
    assert.equal(await outcome.innerText(), 'Resume did not complete (invalid_state): Task in state failed cannot resume');
    assert.equal(await outcome.getAttribute('role'), 'alert');
    // The same controls work from the board card.
    const card = page.locator('#board [data-ref="E00:task:t2@1"]');
    await card.locator('[data-control="task.pause"]').focus();
    await page.keyboard.press('Enter');
    await card.locator('[data-outcome="ok"]').waitFor();
    assert.equal(await card.locator('[data-outcome]').innerText(), 'Pause: succeeded. New state: paused.');
    assert.match(await card.locator('[data-deps]').innerText(), /Waits on 1 \(1 not done\): Draft scene one \[not done\]/);
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});

test('accessibility: axe-core finds no serious or critical violations in any view, light or dark', skip, async () => {
  for (const colorScheme of ['light', 'dark']) {
    const { page, context, problems } = await open({ colorScheme });
    try {
      await axe(page, `${colorScheme} graph`);
      await page.locator('#graph [data-view="table"]').click(); await axe(page, `${colorScheme} table`);
      await page.locator('#graph [data-view="text"]').click(); await axe(page, `${colorScheme} text`);
      for (const tab of ['sources', 'versions', 'permissions', 'history', 'raw']) { await page.locator(`#inspector [data-tab="${tab}"]`).click(); await axe(page, `${colorScheme} inspector ${tab}`); }
      await page.locator('#q').fill('transfer'); await page.keyboard.press('Enter'); await page.waitForSelector('#search .ws-search__group'); await axe(page, `${colorScheme} search`);
      await page.evaluate(() => window.workspaceDemo.navigate('E00:task:t1'));
      await page.locator('#controls [data-control="task.cancel"]').click(); await page.waitForSelector('[role="dialog"]'); await axe(page, `${colorScheme} dialog`);
      await page.keyboard.press('Escape');
      await page.evaluate(() => window.workspaceDemo.navigate('E06:derivative:d1')); await axe(page, `${colorScheme} disconnected`);
      assert.deepEqual(problems, []);
    } finally { await context.close(); }
  }
});

test('reflow: usable at 200% zoom and on a narrow viewport without horizontal page scrolling', skip, async () => {
  // 1280 CSS px at 200% zoom is a 640 px layout viewport; 320 px is the WCAG reflow width.
  for (const viewport of [{ width: 640, height: 450 }, { width: 320, height: 640 }]) {
    const { page, context, problems } = await open({ viewport, deviceScaleFactor: 2 });
    try {
      const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(await overflow() <= 1, `page scrolls horizontally at ${viewport.width}px (graph)`);
      const box = await page.locator('#graph svg').boundingBox();
      assert.ok(box.width <= viewport.width && box.width > 200);
      await tabTo(page, '#graph [data-ref]');
      await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
      const node = await page.evaluate(() => { const r = document.activeElement.getBoundingClientRect(), s = document.activeElement.ownerSVGElement.getBoundingClientRect(); return { inside: r.left >= s.left - 1 && r.right <= s.right + 1 && r.top >= s.top - 1 && r.bottom <= s.bottom + 1 }; });
      assert.equal(node.inside, true, 'the focused node is panned into view');
      await page.keyboard.press('Enter');
      await page.locator('#graph [data-view="table"]').click();
      assert.ok(await overflow() <= 1, `page scrolls horizontally at ${viewport.width}px (table)`);
      await page.locator('#graph [data-view="text"]').click();
      assert.ok(await overflow() <= 1, `page scrolls horizontally at ${viewport.width}px (text)`);
      for (const tab of ['history', 'raw']) { await page.locator(`#inspector [data-tab="${tab}"]`).click(); assert.ok(await overflow() <= 1, `inspector ${tab} overflows at ${viewport.width}px`); }
      await page.evaluate(() => window.workspaceDemo.navigate('E00:task:t1'));
      await page.locator('#controls [data-control="task.cancel"]').click();
      const dialog = await page.locator('[role="dialog"]').boundingBox();
      assert.ok(dialog.x >= 0 && dialog.x + dialog.width <= viewport.width + 1, 'the dialog fits the viewport');
      await page.locator('[data-dialog="cancel"]').click();
      await axe(page, `${viewport.width}px`);
      assert.deepEqual(problems, []);
    } finally { await context.close(); }
  }
});

test('audit timeline: virtualised rows, filters by engine, actor and action, export callback', skip, async () => {
  const { page, context, problems } = await open();
  try {
    await page.evaluate(async () => {
      const ws = await import('./index.js');
      const host = document.createElement('div'); host.id = 'big'; document.querySelector('main').prepend(host);
      const records = Array.from({ length: 5000 }, (_, i) => ({ engine: i % 3 === 0 ? 'E05' : 'E07', id: String(i + 1), tenantSeq: i + 1, projectId: 'p1', at: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(), actorId: i % 2 === 0 ? 'ana' : 'bea', actorKind: 'human', action: i % 5 === 0 ? 'thing.corrected' : 'thing.saved', subject: `E05:evidence:ev${i}`, requestId: `req-${i}`, purpose: 'test', detail: null, hash: 'x' }));
      window.exported = []; window.navigated = [];
      window.big = ws.AuditTimeline(host, { records, engines: [{ engine: 'E05', name: 'Evidence', status: 'ok', count: 1667, chain: 'verified', exhausted: true }, { engine: 'E07', name: 'Knowledge', status: 'ok', count: 3333, chain: 'broken', exhausted: true }, { engine: 'E06', name: 'Processing', status: 'unavailable', reason: 'timeout', count: 0, chain: 'not_checked', exhausted: false }], truncated: true, height: 300,
        onExport: (format, filter) => window.exported.push([format, filter]), onNavigate: (ref) => window.navigated.push(ref), onLoadMore: () => { window.more = true; } });
    });
    const big = page.locator('#big');
    assert.equal(await big.locator('[role="table"]').getAttribute('aria-rowcount'), '5001');
    const inDom = await big.locator('[role="rowgroup"] [role="row"][data-index]').count();
    assert.ok(inDom > 3 && inDom < 60, `only the visible window is rendered (${inDom} rows)`);
    assert.match(await big.locator('[role="status"]').innerText(), /Showing 5000 of 5000 loaded records; more exist on the server\./);
    assert.match(await big.innerText(), /Knowledge \(E07\): 3333 records, HASH CHAIN BROKEN/);
    assert.match(await big.innerText(), /Processing \(E06\): unavailable \(timeout\)/);
    // Scrolling with the keyboard renders later rows with their true row index.
    await big.locator('.ws-timeline__scroll').focus();
    await page.keyboard.press('End');
    await page.waitForFunction(() => document.querySelector('#big [data-index="4999"]') !== null);
    assert.equal(await big.locator('[data-index="4999"]').getAttribute('aria-rowindex'), '5001');
    assert.equal(await big.locator('[data-index="0"]').count(), 0);
    assert.ok(await big.locator('[role="row"][data-index]').count() < 60);
    await big.locator('[data-index="4999"] button').click();
    assert.deepEqual(await page.evaluate(() => window.navigated), ['E05:evidence:ev4999']);
    // Filters
    await big.locator('[data-filter="engine"]').selectOption('E05');
    assert.match(await big.locator('[role="status"]').innerText(), /Showing 1667 of 5000/);
    assert.equal(await big.locator('[role="table"]').getAttribute('aria-rowcount'), '1668');
    await big.locator('[data-filter="actor"]').selectOption('bea');
    await big.locator('[data-filter="action"]').selectOption('thing.corrected');
    const shown = Number((await big.locator('[role="status"]').innerText()).match(/Showing (\d+)/)[1]);
    assert.equal(shown, Array.from({ length: 5000 }, (_, i) => i).filter((i) => i % 3 === 0 && i % 2 === 1 && i % 5 === 0).length);
    assert.ok((await big.locator('[role="row"][data-index]').allInnerTexts()).every((t) => /E05[\s\S]*bea[\s\S]*thing\.corrected/.test(t)));
    await big.locator('[data-filter="text"]').pressSequentially('ev15');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-filter')), 'text', 'typing keeps focus in the filter');
    assert.match(await big.locator('[role="status"]').innerText(), /Showing \d+ of 5000/);
    await big.locator('[data-filter="text"]').fill('no such record');
    assert.match(await big.innerText(), /No records match these filters\./);
    await big.locator('[data-export="csv"]').click();
    assert.deepEqual(await page.evaluate(() => window.exported), [['csv', { engine: 'E05', actor: 'bea', action: 'thing.corrected', text: 'no such record' }]]);
    await big.locator('[data-more]').click();
    assert.equal(await page.evaluate(() => window.more), true);
    await axe(page, 'timeline');
    await page.evaluate(() => window.big.destroy());
    assert.equal(await big.locator('*').count(), 0, 'destroy removes everything');
    assert.deepEqual(problems, []);
  } finally { await context.close(); }
});
