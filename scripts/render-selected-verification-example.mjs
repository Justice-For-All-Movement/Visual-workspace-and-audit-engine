import { JSDOM } from "jsdom";
import { writeFile } from "node:fs/promises";
import { frameFixture } from "../tests/selected-verification-fixture.ts";
import { renderSelectedVerificationFrame } from "../dist/selected-verification.js";

const { scope, selected, frame } = frameFixture();
const dom = new JSDOM(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fictional private selected review</title><style>
body{margin:2rem auto;padding:0 1rem;max-width:60rem;font:1rem/1.6 system-ui;color:#17222e;background:#f5f7fb}
main{padding:1.5rem;background:white;border:1px solid #758292;border-radius:.5rem}h1,h2,h3{line-height:1.3}pre{overflow:auto;max-height:32rem;padding:1rem;color:#15283c;background:#edf2f8;border:1px solid #758292;white-space:pre-wrap;overflow-wrap:anywhere}
</style></head><body><main><h1>Fictional private selected review</h1><p>Offline example from neutral pure fixtures. No session, service request or current permission has been established. No source bytes or audit history are loaded.</p></main></body></html>`);
dom.window.document.querySelector("main").append(renderSelectedVerificationFrame(dom.window.document, scope, selected, JSON.stringify(frame)));
await writeFile(new URL("../docs/examples/private-selected-verification-read.html", import.meta.url), dom.serialize() + "\n");
