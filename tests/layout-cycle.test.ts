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

// --- Issue #267 review round 1: a visit to Experimental must never touch Rooms v1's own
// storage. The hex layout used to sweep the shared legacy room-kind-list key on construction
// (`dropLegacyRoomStorage`, built back when that key really was dead data) — Rooms v1's
// restore made it live data again, so that sweep would wipe a real room list the first time a
// browser that has Rooms v1's rooms visits Experimental. Both layouts are constructed directly
// here (not through the registry) so the same storage object stands in for one browser's
// `window.localStorage` across a real layout switch. ---

test('visiting Experimental and back never loses Rooms v1\'s own rented rooms', async () => {
  const THREE = await import('three');
  const { BuildingLayoutV1 } = await import('../src/addons/building-v1/BuildingLayout.js');
  const { BuildingLayout } = await import('../src/addons/building/BuildingLayout.js');

  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };

  // Rooms v1 rents past the office and the library (the starter pair every fresh building
  // opens with) — a third room, directly seeded the same shape `tests/building-v1.test.ts`
  // already relies on.
  store.set('agents-office.building.rooms', JSON.stringify(['office', 'library', 'desks']));
  const v1First = new BuildingLayoutV1(new THREE.Scene(), new Map(), { storage });
  assert.deepEqual(v1First.roomKinds, ['office', 'library', 'desks']);

  // The same browser's storage, now handed to a freshly constructed hex layout — the same
  // object `main.ts` would pass from `window.localStorage` on a Shift+L switch to Experimental.
  new BuildingLayout(new THREE.Scene(), new Map(), { storage });
  assert.equal(store.get('agents-office.building.rooms'), JSON.stringify(['office', 'library', 'desks']), 'the hex layout never touches Rooms v1\'s storage key');

  // Switching back: a fresh Rooms v1 instance, same storage, must still see its own rooms.
  const v1Second = new BuildingLayoutV1(new THREE.Scene(), new Map(), { storage });
  assert.deepEqual(v1Second.roomKinds, ['office', 'library', 'desks']);
});
