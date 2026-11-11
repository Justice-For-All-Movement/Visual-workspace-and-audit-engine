import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
test("registry accepts verified transferred repository and rejects unrelated or stale CI identity", () => {
  const cwd = new URL("..", import.meta.url);
  for (const repository of ["Justice-For-All-Movement/Visual-workspace-and-audit-engine", "unrelated/Visual-workspace-and-audit-engine", "neophilism/Visual-workspace-and-audit-engine"]) {
    const result = spawnSync(process.execPath, ["scripts/validate-pr-registry.mjs"], {
      cwd, env: { ...process.env, GITHUB_REPOSITORY: repository }, encoding: "utf8",
    });
    assert.equal(result.error, undefined);
    if (repository.startsWith("Justice-For-All-Movement/")) assert.equal(result.status, 0, result.stderr);
    else { assert.notEqual(result.status, 0); assert.match(result.stderr, /Invalid repository identity/); }
  }
});
