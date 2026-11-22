/**
 * Issue #267: Shift+L cycles three layouts — Original, Rooms v1 (stable), Experimental (hex).
 * `addons/building-v1.ts` registers the restored rect building under the historical `building`
 * id (the default slot), so a stored preference from before the hex work migrates to Rooms v1
 * with no migration code at all; `addons/building.ts` now registers the hex layout under a new
 * `hex` id. This file imports both add-ons for real (the same `import.meta.glob` eager load
 * `main.ts` does) and asserts on the real, shared `layout/registry.js` singleton.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

// Toon materials paint a gradient on a canvas at import time; room signs need a document.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;

// The same two add-on files `main.ts` loads via `import.meta.glob('./addons/*.ts', { eager: true })`.
await import('../src/addons/building-v1.js');
await import('../src/addons/building.js');
const registry = await import('../src/layout/registry.js');

test('the three layouts register in cycle order: Original, Rooms v1, Experimental', () => {
  assert.deepEqual(registry.layoutIds(), ['activity', 'building', 'hex']);
  assert.equal(registry.layoutName('activity'), 'Original');
  assert.equal(registry.layoutName('building'), 'Rooms v1');
  assert.equal(registry.layoutName('hex'), 'Experimental');
});

test('Shift+L cycles forward through all three and wraps back to the first', () => {
  const next = (id: string) => registry.confirmLayoutSwitch(id, () => true);
  assert.equal(next('activity'), 'building');
  assert.equal(next('building'), 'hex');
  assert.equal(next('hex'), 'activity');
});

test('a fresh visit (no URL layout, nothing stored) defaults to Rooms v1', () => {
  assert.equal(registry.chooseLayoutId('', undefined), 'building');
});

test('a stored "building" preference from before the hex work keeps resolving to Rooms v1, with no migration step needed', () => {
  const storage = { getItem: (key: string) => (key === 'agents-office.layout' ? 'building' : null) };
  assert.equal(registry.chooseLayoutId('', storage), 'building');
  assert.equal(registry.layoutName(registry.chooseLayoutId('', storage)), 'Rooms v1');
});

test('?layout=hex and ?layout=activity both still resolve by URL, same as any other layout id', () => {
  assert.equal(registry.chooseLayoutId('?layout=hex', undefined), 'hex');
  assert.equal(registry.chooseLayoutId('?layout=activity', undefined), 'activity');
});

test('Rooms v1 and Experimental both ask for the isometric start view; Original keeps first person', () => {
  assert.equal(registry.defaultViewFor('building'), 'isometric');
  assert.equal(registry.defaultViewFor('hex'), 'isometric');
  assert.equal(registry.defaultViewFor('activity'), 'first-person');
});
