# Private unresolved verification editor

`./verification-write-controls` exports `mountVerificationWrite(root, client, selected, nextCommandId)`. It exclusively owns an actual `VerificationWriteClient` in the same HTTPS origin. Mounting makes no request. The host supplies unique command IDs and must dispose on logout, identity/purpose changes and navigation.

Read explicitly before editing the four literal check statuses/notes and rationale. Stored statuses are copied without inferring reviewed work; even all-reviewed records remain unresolved human assertions. Unsaved edits block reload, including directly dispatched clicks. Explicit discard restores captured values. Save binds the actual containing storage revision separately from the logical review revision through the accepted client. No caller-provided frame or viewer is admitted.

A successful acknowledgement selects only its returned exact record reference, clears the captured view, and requires a separate explicit read. It never manufactures record histories/audits or automatically reloads/rebases. Any uncertain, rejected or malformed dispatched write locks editing, reads and discard. Only explicit identical replay with fresh session CSRF is available. Pending data remains in client memory; the host must retain/recover it safely across lifecycle/reload. Disposing clears displayed fields and observations but retains pending data in the closed client for host recovery; it does not prove rollback or prevent begun server SQL from committing.

Busy guards precede host command-ID generation; detached/replaced elements close the client and remove private content. Native labels/buttons and inert text rendering are provided. JSDOM is not actual browser/assistive-technology or informed-consent acceptance. Session metadata is not identity proofing. Current Identity/Consent/Evidence checks remain sequential, not a distributed permission fence. No sends, publication or execution routes are added.

## Checkpoint

Explicitly incomplete WIP in Visual PR25. Six focused local groups pass: three actual accepted HTTP-handler/four restricted migrated database/encrypted Evidence scenarios, and three synthetic/JSDOM lifecycle scenarios. Typecheck/build/registry pass after correcting a test-only TypeScript narrowing error. Installed qualification, expanded adversarial source review, full final regression and current-head CI are still required. No independent SQL network-session, real browser/AT, live scanner/session proofing or deployment claim.
