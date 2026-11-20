import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import type { Seat, LayoutStrategy } from '../src/layout/LayoutStrategy.js';

// Toon materials paint a gradient on a canvas at import time.
const dom = new JSDOM('<!doctype html><html><body><div id="pointer-hint"></div></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { AgentManager } = await import('../src/agents/AgentManager.js');
const { ViewController } = await import('../src/scene/ViewController.js');
const { SelectionState } = await import('../src/scene/Selection.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

const fixedLayout: LayoutStrategy = {
  id: 'fixed',
  seatFor: (agent): Seat => ({ key: agent.id, position: new THREE.Vector3(4, 0, -3), lookAt: new THREE.Vector3(4, 0, 0) }),
  release: () => undefined,
};

function setup(hash = '', figureShiftPx?: () => number) {
  const document = dom.window.document;
  const scene = new THREE.Scene();
  const wall = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  wall.userData.overviewHidden = true;
  scene.add(wall);
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
  camera.position.set(-12, 5.5, 11);
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth', { value: 1600, configurable: true });
  Object.defineProperty(canvas, 'clientHeight', { value: 900, configurable: true });
  document.body.appendChild(canvas);
  const manager = new AgentManager(scene, fixedLayout);
  const selection = new SelectionState();
  const hint = document.getElementById('pointer-hint');
  const view = new ViewController({
    camera, canvas, scene, selection, hint,
    agents: () => manager.getAgents(),
    keys: dom.window,
    hash,
    ...(figureShiftPx ? { figureShiftPx } : {}),
  });
  const press = (code: string) => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code, key: code }));
  return { view, camera, canvas, scene, manager, selection, wall, hint, press };
}

test('first person stays the default and the camera does not move by itself', () => {
  const { view, camera, wall } = setup();
  view.update(1, 1 / 60);
  assert.equal(view.mode, 'first-person');
  assert.deepEqual(camera.position.toArray(), [-12, 5.5, 11]);
  assert.equal(wall.visible, true);
});

test('key O switches to the overview and back, hiding near walls only in the overview', () => {
  const { view, camera, wall, hint, press } = setup();
  press('KeyO');
  assert.equal(view.mode, 'overview');
  assert.equal(wall.visible, false);
  assert.match(hint!.textContent ?? '', /wheel/i);
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
  assert.ok(camera.position.y > 15, `overview camera is high above the floor (${camera.position.y})`);

  press('KeyO');
  for (let i = 0; i < 60; i++) view.update(1 + i / 60, 1 / 60);
  assert.equal(view.mode, 'first-person');
  assert.equal(wall.visible, true);
  assert.ok(camera.position.distanceTo(new THREE.Vector3(-12, 5.5, 11)) < 1e-6);
});

test('#view=overview starts in the overview', () => {
  const { view, camera } = setup('#view=overview');
  view.update(0, 1 / 60);
  assert.equal(view.mode, 'overview');
  assert.ok(camera.position.y > 15);
});

test('#focus selects the agent once it appears, and flies the camera to it', () => {
  const { view, manager, selection, camera } = setup('#view=overview&focus=agent-1');
  view.agentsChanged(manager.getAgents());
  assert.equal(selection.selected, null);

  manager.addAgent({ id: 'agent-1', name: 'One', activity: 'idle' });
  view.agentsChanged(manager.getAgents());
  assert.equal(selection.selected, 'agent-1');
  const startPosition = camera.position.clone();
  // One tick in: a tween eases, an instant jump would already sit at the end position (issue #113).
  view.update(0, 1 / 60);
  const afterOneTick = camera.position.distanceTo(startPosition);
  for (let i = 1; i < 60; i++) view.update(i / 60, 1 / 60);
  const totalFlight = camera.position.distanceTo(startPosition);
  assert.ok(afterOneTick < totalFlight * 0.2, `the first tick covers only a small fraction of the flight (${afterOneTick} of ${totalFlight})`);
  const lookAt = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const toAgent = new THREE.Vector3(4, 0, -3).sub(camera.position).normalize();
  assert.ok(lookAt.dot(toAgent) > 0.99, 'the camera looks at the selected agent');

  selection.clear();
  view.agentsChanged(manager.getAgents());
  assert.equal(selection.selected, null, 'the focus applies only once');
});

test('Esc clears the selection and an agent that leaves is deselected', () => {
  const { view, manager, selection, press } = setup();
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  selection.select('a');
  press('Escape');
  assert.equal(selection.selected, null);

  selection.select('a');
  manager.removeAgent('a');
  view.agentsChanged(manager.getAgents());
  assert.equal(selection.selected, null);
});

test('selecting in first person flies there and keeps first person', () => {
  const { view, manager, selection, camera } = setup();
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  selection.select('a');
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
  assert.equal(view.mode, 'first-person');
  assert.ok(camera.position.distanceTo(new THREE.Vector3(4, 0, -3)) < 7);
});

test('zoomDistance reports the overview camera distance and follows the wheel', () => {
  const { view } = setup('#view=overview');
  const before = view.zoomDistance;
  assert.ok(Number.isFinite(before) && before > 0);
  const canvases = dom.window.document.querySelectorAll('canvas');
  const canvas = canvases[canvases.length - 1];
  canvas.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: -400, cancelable: true }));
  assert.ok(view.zoomDistance < before, `zoomed in (${view.zoomDistance} < ${before})`);
});

test('the overview keeps the pan limits current when a room appears without re-entering it (issue #113)', () => {
  const { view, scene } = setup('#view=overview');
  // A base floor, like the building's own: without it the only floor object below would be
  // the new annex, which would shrink the bounds instead of growing them.
  const base = new THREE.Mesh(new THREE.PlaneGeometry(30, 26));
  base.rotation.x = -Math.PI / 2;
  base.userData.floor = true;
  scene.add(base);
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
  const overview = (view as unknown as { overview: { maxDistance: number; target: THREE.Vector3; pan(right: number, forward: number): void } }).overview;
  const before = overview.maxDistance;

  const annex = new THREE.Mesh(new THREE.PlaneGeometry(10, 10));
  annex.rotation.x = -Math.PI / 2;
  annex.position.set(60, 0, 0);
  annex.userData.floor = true;
  scene.add(annex);
  view.agentsChanged([]);

  assert.ok(overview.maxDistance > before, 'the zoom-out limit grows to fit the new room');
  overview.target.set(0, 0, 0);
  overview.pan(1e7, 0);
  const posX = overview.target.x;
  overview.target.set(0, 0, 0);
  overview.pan(-1e7, 0);
  const negX = overview.target.x;
  assert.ok(Math.max(posX, negX) > 30, `the pan reaches the new room (posX=${posX}, negX=${negX})`);
});

test('the overview recomputes the zoom-out limit on a resize without re-entering it (issue #113)', () => {
  const { view, canvas } = setup('#view=overview');
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
  const overview = (view as unknown as { overview: { maxDistance: number } }).overview;
  const before = overview.maxDistance;
  Object.defineProperty(canvas, 'clientWidth', { value: 300, configurable: true });
  dom.window.dispatchEvent(new dom.window.Event('resize'));
  assert.notEqual(overview.maxDistance, before, 'a narrower window recomputes the zoom-out limit');
});

test('a room change and a resize in first person do nothing (no pan-limit view is active)', () => {
  const { view, scene, canvas } = setup();
  const annex = new THREE.Mesh(new THREE.PlaneGeometry(10, 10));
  annex.userData.floor = true;
  scene.add(annex);
  view.agentsChanged([]); // must not throw outside the overview or the isometric view
  Object.defineProperty(canvas, 'clientWidth', { value: 300, configurable: true });
  dom.window.dispatchEvent(new dom.window.Event('resize'));
  assert.equal(view.mode, 'first-person');
});

function screenX(camera: THREE.PerspectiveCamera, point: THREE.Vector3): number {
  camera.updateMatrixWorld();
  return point.clone().project(camera).x;
}

for (const hash of ['#view=overview', '']) {
  const mode = hash ? 'overview' : 'first person';
  test(`${mode}: with an open agent card the camera frames the figure left of the card`, () => {
    const { view, manager, selection, camera } = setup(hash, () => 300);
    manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
    selection.select('a');
    for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
    const target = hash ? new THREE.Vector3(4, 0, -3) : new THREE.Vector3(4, 1.1, -3);
    // 300 px left of the center of a 1600 px canvas is -0.375 in normalized device coordinates.
    assert.ok(Math.abs(screenX(camera, target) + 0.375) < 0.02, `figure at x=${screenX(camera, target)}`);
  });

  test(`${mode}: without a card shift the camera centers the figure (old behavior)`, () => {
    const { view, manager, selection, camera } = setup(hash);
    manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
    selection.select('a');
    for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
    const target = hash ? new THREE.Vector3(4, 0, -3) : new THREE.Vector3(4, 1.1, -3);
    assert.ok(Math.abs(screenX(camera, target)) < 0.02, `figure at x=${screenX(camera, target)}`);
  });
}

test('a click that misses every agent closes the open agent card (issue #133)', () => {
  const { view, manager, selection, canvas } = setup();
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  selection.select('a');
  canvas.dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: 10, clientY: 10, button: 0 }));
  canvas.dispatchEvent(new dom.window.MouseEvent('click', { clientX: 10, clientY: 10 }));
  assert.equal(selection.selected, null);
});

test('a drag release is never misread as a closing click (issue #133)', () => {
  const { view, manager, selection, canvas } = setup();
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  selection.select('a');
  canvas.dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: 10, clientY: 10, button: 0 }));
  dom.window.document.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 400, clientY: 10 }));
  dom.window.document.dispatchEvent(new dom.window.MouseEvent('pointerup', { clientX: 400, clientY: 10 }));
  canvas.dispatchEvent(new dom.window.MouseEvent('click', { clientX: 400, clientY: 10 }));
  assert.equal(selection.selected, 'a', 'the drag release does not clear the card');
});

test('an out-and-back pan in the overview is never misread as a closing click (issue #133)', () => {
  const { view, manager, selection, canvas, press } = setup();
  press('KeyO'); // overview: the only mode that pans on drag
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  selection.select('a');
  canvas.dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: 10, clientY: 10, button: 0 }));
  // Past the click tolerance, then back near the press point: `isClick` alone compares only
  // endpoints, so without tracking the drag itself this reads as a miss on release.
  dom.window.document.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 400, clientY: 10 }));
  dom.window.document.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 10, clientY: 10 }));
  dom.window.document.dispatchEvent(new dom.window.MouseEvent('pointerup', { clientX: 10, clientY: 10 }));
  canvas.dispatchEvent(new dom.window.MouseEvent('click', { clientX: 10, clientY: 10 }));
  assert.equal(selection.selected, 'a', 'a pan that returns near the press point still does not clear the card');
});

test('a click while pointer-locked is for looking, not for closing the card (issue #133)', () => {
  const { view, manager, selection, canvas } = setup();
  const document = dom.window.document;
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  selection.select('a');
  Object.defineProperty(document, 'pointerLockElement', { value: canvas, configurable: true });
  canvas.dispatchEvent(new dom.window.MouseEvent('pointerdown', { clientX: 10, clientY: 10, button: 0 }));
  canvas.dispatchEvent(new dom.window.MouseEvent('click', { clientX: 10, clientY: 10 }));
  assert.equal(selection.selected, 'a', 'a locked click looks around, it does not close the card');
  Object.defineProperty(document, 'pointerLockElement', { value: null, configurable: true });
});

test('a click outside the canvas (the card, a panel, the legend) never reaches the click handler (issue #133)', () => {
  const { view, manager, selection } = setup();
  const document = dom.window.document;
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  selection.select('a');
  const card = document.createElement('div');
  document.body.appendChild(card);
  card.dispatchEvent(new dom.window.MouseEvent('click', { clientX: 10, clientY: 10, bubbles: true }));
  assert.equal(selection.selected, 'a', 'a click on a sibling element never clears the card');
  card.remove();
});

test('first person: the card shift turns only the aim; the camera stands where the unshifted flight puts it', () => {
  const fly = (shift?: () => number) => {
    const { view, manager, selection, camera } = setup('', shift);
    manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
    selection.select('a');
    for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
    return { position: camera.position.clone(), forward: new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion) };
  };
  const plain = fly();
  const shifted = fly(() => 300);
  assert.ok(shifted.position.distanceTo(plain.position) < 1e-6, `camera moved by ${shifted.position.distanceTo(plain.position)}`);
  assert.ok(shifted.forward.angleTo(plain.forward) > 0.05, 'the aim turns toward the screen right');
});
