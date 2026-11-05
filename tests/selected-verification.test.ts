import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { frameFixture } from "./selected-verification-fixture.ts";
import {
  parseSelectedVerificationFrame,
  renderSelectedVerificationFrame,
} from "../src/selected-verification.ts";

test("selected frame uses exact owning pure records without manufacturing histories", () => {
  const { scope, selected, frame } = frameFixture();
  const input = JSON.stringify(frame),
    result = parseSelectedVerificationFrame(scope, selected, input);
  assert.deepEqual(result, frame);
  assert.notEqual(result.record, frame.record);
  const later: any = structuredClone(frame);
  later.record.ref.revision = 3;
  later.record.supersedes = { ...selected, revision: 2 };
  later.reviewRevision = 9;
  assert.deepEqual(
    parseSelectedVerificationFrame(
      scope,
      later.record.ref,
      JSON.stringify(later),
    ),
    later,
  );
  // Observed aggregate edition 9 is retained; no missing eight history records are synthesized.
});

test("selected frame denies foreign, mismatched, extra authority and lost contrary metadata", () => {
  const { scope, selected, frame } = frameFixture();
  const mutations = [
    (f: any) => {
      f.record.claim.projectId = "elsewhere";
    },
    (f: any) => {
      f.record.ref.id = "other";
    },
    (f: any) => {
      f.record.claim.revision++;
    },
    (f: any) => {
      f.record.assessment = "verified";
    },
    (f: any) => {
      f.record.challengeLinkIds = [];
    },
    (f: any) => {
      f.record.supersedes = selected;
    },
    (f: any) => {
      f.record.checks.authenticity.permit = true;
    },
    (f: any) => {
      f.record.createdAt = "2026-02-30T00:00:00Z";
    },
    (f: any) => {
      f.revision.links.push(f.revision.links[0]);
    },
    (f: any) => {
      f.revision.links[0].selector.evidence.projectId = "elsewhere";
    },
    (f: any) => {
      f.revision.links[0].family.basisDigest = "bad";
    },
    (f: any) => {
      f.history = [f.record];
    },
    (f: any) => {
      f.reviewRevision = 0;
    },
    (f: any) => {
      f.knowledgeRevision = 2049;
    },
  ];
  for (const mutate of mutations) {
    const f = structuredClone(frame);
    mutate(f);
    assert.throws(
      () => parseSelectedVerificationFrame(scope, selected, JSON.stringify(f)),
      /invalid_response/,
    );
  }
});

test("minimal frame DOM remains literal and identifies unloaded data and containing editions", () => {
  const { scope, selected, frame } = frameFixture();
  (frame.record as any).rationale =
    "</pre><script>window.injected=true</script> $&";
  const dom = new JSDOM("<!doctype html><body></body>", {
    runScripts: "dangerously",
  });
  const view = renderSelectedVerificationFrame(
    dom.window.document,
    scope,
    selected,
    JSON.stringify(frame),
  );
  dom.window.document.body.append(view);
  assert.equal(view.querySelectorAll("script,a,iframe,img,button").length, 0);
  assert.equal((dom.window as any).injected, undefined);
  assert.ok(view.textContent!.includes(frame.record.rationale));
  assert.match(
    view.textContent!,
    /source bytes, predecessor history and audit events are not loaded/,
  );
  assert.deepEqual(JSON.parse(view.querySelector("pre")!.textContent!), frame);
});

test("wire budget measures UTF8 bytes and rejects complete over-budget responses", () => {
  const { scope, selected, frame } = frameFixture();
  const base = JSON.stringify(frame),
    max = 512 * 1024;
  const exact = base + " ".repeat(max - Buffer.byteLength(base));
  assert.deepEqual(
    parseSelectedVerificationFrame(scope, selected, exact),
    frame,
  );
  assert.throws(
    () => parseSelectedVerificationFrame(scope, selected, exact + " "),
    /invalid_response/,
  );
  assert.throws(
    () =>
      parseSelectedVerificationFrame(
        scope,
        selected,
        base + "\u00a0".repeat(max / 2),
      ),
    /invalid_response/,
  );
});
