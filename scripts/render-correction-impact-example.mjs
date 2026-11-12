import {writeFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {impactFixture} from '../tests/selected-correction-impact-fixture.ts';
import {renderSelectedCorrectionImpactFrame} from '../dist/selected-correction-impact.js';
const {scope,selected,frame}=impactFixture();
const dom=new JSDOM('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Fictional private correction impact</title></head><body><h1>Fictional private example</h1><p>Offline neutral fixture; no authentication, service observation, export authorization or live workflow qualification.</p><main></main></body></html>');
dom.window.document.querySelector('main').append(renderSelectedCorrectionImpactFrame(dom.window.document,scope,selected,JSON.stringify(frame)));
await writeFile(new URL('../docs/examples/private-selected-correction-impact.html',import.meta.url),dom.serialize()+'\n');
