# Private selected verification reads

This read-only browser integration uses accepted Knowledge PR24. It explicitly upgrades the direct Knowledge SDK from a6d50806af49160ca786d77e1477532cd5840e2c to31211e545f73dd99318d2960be3212a511b7cffd. Only the root and resolved Knowledge lock entries change. Other direct/nested pins, stable SQL, shared contracts and original task dependencies remain unchanged.

## Minimal response view

`./selected-verification` exports the typed minimal frame, `parseSelectedVerificationFrame(scope, selected, jsonText)` and `renderSelectedVerificationFrame(document, scope, selected, jsonText)`. Admission checks exact scoped selection/citation binding, private unresolved/null tracks, all four literal checks, all contrary link IDs, selector/family/fingerprint syntax, unloaded predecessor reference continuity and observed containing counts. It rejects extra authority fields and oversized complete responses. This is syntax and self-consistency admission, not authentication, a complete history validator, source observation, truth, work proof, findings, answers or permission.

Only the selected review record and exact citation-set record are present. Claim text, source bytes, preceding histories and independent audits are **not loaded**. Aggregate observation revisions are retained without becoming record creation editions. The existing pure and whole-history stored renderers retain their contracts; no synthetic histories are created to call them. All visible strings use textContent. The exact frame remains available as inert literal metadata.

## Explicit client and controls

`VerificationReadClient(origin, scope, purpose, transport, timeoutMs?)` in `./verification-client` captures the fixed HTTPS configuration. Each explicit `read(selected, signal?)` first obtains a fresh session/CSRF, then POSTs exactly the captured selection to `/private/verification/review`. The client uses same-origin credentials/mode, no-store, redirect-error and no-referrer. It never stores a response or polls/retries automatically. A changed actor permanently closes the client before another selected POST. Caller selection accessors are rejected before I/O, and later caller mutation cannot change the captured configuration or request.

| Limit | Admission |
| --- | --- |
| Entire explicit read | Default10s, configurable1..30000ms; one monotonic deadline across both exchanges, stream/JSON/copy gates |
| Selected request | Exact selected Ref; at most1024 UTF8 bytes |
| Session response | Exact actorId/csrfToken, at most4096 bytes |
| Selected response | At most512KiB UTF8 and4096 chunks; strict decoding/exact framing |
| CSRF | Nonempty, at most256 UTF8 bytes |
| Response | HTTP200, expected origin/path if supplied, no redirect, JSON and no-store headers |

Owned signals close on every exit. Cancellation, timeout and disposal fence late data and request body cancellation, including noncooperative transport settlements. Diagnostics are sanitized. A hung host callback can continue; the client cannot terminate it or establish SQL rollback. Backend checked-read audits may commit despite a lost response. An explicit later read is a new current check, never an execution permit.

`mountVerificationRead(root, client, selected)` in `./verification-controls` requires the matching document origin and owns one client/fixed selection. It displays the exact selection before making any request and offers one explicit native read button. Busy direct dispatch is fenced. Every read clears previous observations immediately; denied/malformed/unknown results leave only a generic unavailable message. Detachment or disposal closes the client and removes its content. No write, grant, acceptance, dispatch or send controls exist.

The host must dispose the component on logout, navigation, identity or purpose changes and enforce current private access. Already copied/rendered bytes cannot be revoked. There is no local/session storage, subscription or protected reload persistence.

## Verification and limits

Twelve final focused local **and installed compiled-public-export** wire/client/JSDOM groups pass. Three additional actual owning HTTP/Identity/Knowledge/Consent/Evidence groups pass in both environments using four distinct restricted canonical-migration PGlite databases and encrypted temporary Evidence objects. These exercise exact read/render without domain revision changes, wrong Evidence human kind, current withdrawal clearing old UI results, revoked resource policy, and superseded selected editions. Fixture classes resolve through the owning Knowledge SDK to preserve older Visual dependency pins. Scanner/session proofing are synthetic, not production qualification.

Typecheck/build/registry and strict installed declarations pass; all three installed runtime modules byte-match the build. The earlier full131 local check and source-bound CI41959341817/check127021705100 pass before final selection hardening/new group; raw logs match source b8b24c078d8a219e23b1356ab10950dcd3fdf8fb with zero failed/skipped tests. No full132 local/installed claim is made. Final current-head CI is required separately. An isolated VM links all three browser ESM modules and admits a selected frame without Node globals/imports; this remains VM evidence, not real-browser/AT acceptance.

The fictional offline example is docs/examples/private-selected-verification-read.html, generated by node scripts/render-selected-verification-example.mjs after building. It establishes no session/current permission. Source review found no unresolved issue in this implemented read-only profile. Hashes are recorded in selected-verification-read-verification.json.

Actual identity proofing, shared mapping/delegation, session/CSRF lifecycle, current rights/clock, TLS/private serving, ingress/concurrency/worker/driver/CPU/heap limits and browser/assistive-technology/live qualification remain required. Current backend checks are sequential, not an atomic external-revocation fence. Protected review writes, wider workflow and full correction impact remain unfinished; original downstream gates stay unmet. No publication, mail send, provider connection, payment or paid infrastructure is enabled. PAM remains at its accepted foundation.
