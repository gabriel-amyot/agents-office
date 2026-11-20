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
const { OFFICE } = await import('../src/utils/Constants.js');
const OFFICE_HALF_X = OFFICE.halfX;
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

test('reselect flies the camera to the already-selected agent again (a marker or the top-count click)', () => {
  const { view, manager, selection, camera } = setup();
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  const figurePosition = manager.getAgents().find((agent) => agent.info.id === 'a')!.figure.group.position;
  selection.select('a');
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);

  // The player wandered off in first person; the camera no longer sits near the agent.
  camera.position.set(50, 0, 50);
  assert.ok(camera.position.distanceTo(figurePosition) > 40, 'the camera should start far from the agent');

  selection.reselect();
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
  assert.ok(camera.position.distanceTo(figurePosition) < 7, `expected the camera back near the agent, got ${camera.position.toArray()}`);
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

/** A floor the size of the building's own, so adding or removing an annex grows or shrinks the bounds instead of replacing them (the only floor object would otherwise be the annex itself). */
function addBaseFloor(scene: THREE.Scene): void {
  const base = new THREE.Mesh(new THREE.PlaneGeometry(30, 26));
  base.rotation.x = -Math.PI / 2;
  base.userData.floor = true;
  scene.add(base);
}

function addAnnex(scene: THREE.Scene, x: number): THREE.Mesh {
  const annex = new THREE.Mesh(new THREE.PlaneGeometry(10, 10));
  annex.rotation.x = -Math.PI / 2;
  annex.position.set(x, 0, 0);
  annex.userData.floor = true;
  scene.add(annex);
  return annex;
}

test("the overview camera's far plane grows with the zoom-out limit, so it never clips the building (review fix 1)", () => {
  const { view, scene, camera } = setup('#view=overview');
  addBaseFloor(scene);
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
  const farBefore = camera.far;

  addAnnex(scene, 600);
  view.agentsChanged([]);

  const overview = (view as unknown as { overview: { maxDistance: number } }).overview;
  assert.ok(camera.far > farBefore, `the far plane grows past its old value (${camera.far} vs ${farBefore})`);
  assert.ok(camera.far >= overview.maxDistance, `the far plane covers the new zoom-out limit (${camera.far} vs ${overview.maxDistance})`);
});

test('a bounds shrink eases the overview camera back inside the new limits, it does not snap (review fix 2)', () => {
  const { view, scene, camera } = setup('#view=overview');
  addBaseFloor(scene);
  const annex = addAnnex(scene, 100);
  view.agentsChanged([]);
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);

  const overview = (view as unknown as { overview: { target: THREE.Vector3 } }).overview;
  overview.target.set(95, 0, 0); // panned out near the annex
  view.update(1, 1 / 60); // one frame with no flight applies this pose to the camera
  const before = camera.position.clone();

  scene.remove(annex); // the room disappears: the bounds shrink back under the camera
  view.agentsChanged([]);
  view.update(1 + 1 / 60, 1 / 60); // a single frame right after the shrink
  const afterOneFrame = camera.position.distanceTo(before);

  for (let i = 0; i < 60; i++) view.update(2 + i / 60, 1 / 60); // let any correction finish
  const total = camera.position.distanceTo(before);
  assert.ok(total > 1, `the shrink does move the camera (moved ${total})`);
  assert.ok(afterOneFrame < total * 0.3, `one frame covers only a small fraction of the correction (${afterOneFrame} of ${total})`);
});

test("the isometric camera's near/far follow the zoom-out limit on every frame, so growth never clips the building (review fix 1)", () => {
  const { view, scene } = setup('#view=iso');
  addBaseFloor(scene);
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
  const camera = view.activeCamera as THREE.OrthographicCamera;
  const farBefore = camera.far;

  addAnnex(scene, 600);
  view.agentsChanged([]);
  view.update(1, 1 / 60); // applyIsometric runs every frame in the isometric mode

  assert.ok(camera.far > farBefore, `the far plane grows past its old value (${camera.far} vs ${farBefore})`);
});

test('a bounds shrink eases the isometric camera back inside the new limits, it does not snap (review fix 2)', () => {
  const { view, scene } = setup('#view=iso');
  addBaseFloor(scene);
  const annex = addAnnex(scene, 100);
  view.agentsChanged([]);
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);

  const iso = (view as unknown as { isometric: { target: THREE.Vector3 } }).isometric;
  iso.target.set(95, 0, 0);
  view.update(1, 1 / 60);
  const camera = view.activeCamera;
  const before = camera.position.clone();

  scene.remove(annex);
  view.agentsChanged([]);
  view.update(1 + 1 / 60, 1 / 60);
  const afterOneFrame = camera.position.distanceTo(before);

  for (let i = 0; i < 60; i++) view.update(2 + i / 60, 1 / 60);
  const total = camera.position.distanceTo(before);
  assert.ok(total > 1, `the shrink does move the camera (moved ${total})`);
  assert.ok(afterOneFrame < total * 0.3, `one frame covers only a small fraction of the correction (${afterOneFrame} of ${total})`);
});

test('a room removed mid-flight does not leave a selection flight off its target (review finding 3, attempted repro)', () => {
  const { view, manager, selection, camera, scene } = setup('#view=overview');
  addBaseFloor(scene);
  manager.addAgent({ id: 'a', name: 'A', activity: 'idle' });
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);
  const annex = addAnnex(scene, 100);
  view.agentsChanged(manager.getAgents());

  selection.select('a'); // starts the flight to the agent
  view.update(0, 0.1); // partway through the 0.6 s flight
  scene.remove(annex); // a room elsewhere disappears mid-flight, shrinking the bounds
  view.agentsChanged(manager.getAgents());
  for (let i = 0; i < 60; i++) view.update(1 + i / 60, 1 / 60); // finish the flight and settle

  const target = new THREE.Vector3(4, 0, -3);
  assert.ok(Math.abs(screenX(camera, target)) < 0.02, `the camera still settles on the agent (x=${screenX(camera, target)})`);
});

test("a shrink while zoomed out near the old limit does not drop the far plane before the correction gets there (review round 3, fix 1)", () => {
  const { view, scene, camera } = setup('#view=overview');
  addBaseFloor(scene);
  const farAnnex = addAnnex(scene, 400);
  view.agentsChanged([]);
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);

  const overview = (view as unknown as { overview: { distance: number; maxDistance: number } }).overview;
  overview.distance = overview.maxDistance; // zoomed all the way out, at the old limit
  view.update(1, 1 / 60); // no flight yet: this pose renders directly
  const liveDistance = overview.distance; // what the camera, as actually rendered, needs the far plane to cover

  scene.remove(farAnnex); // the bounds shrink back to the base floor alone
  view.agentsChanged([]); // refreshBounds: this used to drop camera.far to the NEW (small) limit at once

  assert.ok(
    camera.far >= liveDistance - 1e-6,
    `the far plane still covers where the camera actually sits, not yet where the correction is heading (far=${camera.far}, live distance=${liveDistance})`,
  );
});

test('a wheel tick during a correction flight moves the camera about as much as a plain tick, not the whole remaining correction (review round 3, fix 2)', () => {
  const { view, scene, camera, canvas } = setup('#view=overview');
  addBaseFloor(scene);
  const annex = addAnnex(scene, 100);
  view.agentsChanged([]);
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);

  const overview = (view as unknown as {
    overview: { target: THREE.Vector3; distance: number; zoom(delta: number): void; pose(): { position: THREE.Vector3; lookAt: THREE.Vector3 } };
  }).overview;
  overview.target.set(95, 0, 0); // panned out near the annex
  view.update(1, 1 / 60); // no flight yet: this pose renders directly
  const liveDistance = overview.distance;

  // Baseline: what one ordinary wheel tick moves the camera from this same live distance, with no flight running.
  const poseBefore = overview.pose();
  overview.zoom(-400);
  const poseAfter = overview.pose();
  const normalTick = poseBefore.position.distanceTo(poseAfter.position);
  overview.distance = liveDistance; // undo the probe zoom; the real repro starts clean

  scene.remove(annex); // the shrink starts a correction flight back toward the base floor
  view.agentsChanged([]);
  view.update(1 + 1 / 60, 1 / 60); // a little way into the correction
  const beforeWheel = camera.position.clone();

  canvas.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY: -400, cancelable: true }));
  view.update(1 + 2 / 60, 1 / 60);
  const jump = camera.position.distanceTo(beforeWheel);

  assert.ok(jump < normalTick * 3, `one wheel tick during a correction moves about as much as a normal tick (moved ${jump}, a normal tick moves ${normalTick})`);
});

test('a second shrink mid-correction retargets the overview flight to the newest bounds, not the first (stale) ones (review round 3, fix 3)', () => {
  const { view, scene } = setup('#view=overview');
  addBaseFloor(scene);
  const nearAnnex = addAnnex(scene, 100);
  const farAnnex = addAnnex(scene, 200);
  view.agentsChanged([]);
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);

  const overview = (view as unknown as { overview: { target: THREE.Vector3 } }).overview;
  overview.target.set(195, 0, 0); // panned out near the farthest annex
  view.update(1, 1 / 60);

  scene.remove(farAnnex); // first shrink: bounds narrow to the near annex, starts a correction
  view.agentsChanged([]);
  view.update(1 + 1 / 60, 1 / 60); // a little way into the first correction

  scene.remove(nearAnnex); // second shrink, mid-flight: bounds narrow further, to the base floor alone
  view.agentsChanged([]);

  const flight = (view as unknown as { flight: { end: { lookAt: THREE.Vector3 } } | null }).flight;
  assert.ok(flight, 'a correction is still in flight after the second shrink');
  assert.ok(
    Math.abs(flight!.end.lookAt.x) <= OFFICE_HALF_X + 1e-6,
    `the flight's own endpoint already matches the newest bounds, not the first shrink's (x=${flight!.end.lookAt.x})`,
  );
});

test('a second shrink mid-correction retargets the isometric flight to the newest bounds, not the first (stale) ones (review round 3, fix 3)', () => {
  const { view, scene } = setup('#view=iso');
  addBaseFloor(scene);
  const nearAnnex = addAnnex(scene, 100);
  const farAnnex = addAnnex(scene, 200);
  view.agentsChanged([]);
  for (let i = 0; i < 60; i++) view.update(i / 60, 1 / 60);

  const iso = (view as unknown as { isometric: { target: THREE.Vector3 } }).isometric;
  iso.target.set(195, 0, 0);
  view.update(1, 1 / 60);

  scene.remove(farAnnex);
  view.agentsChanged([]);
  view.update(1 + 1 / 60, 1 / 60);

  scene.remove(nearAnnex);
  view.agentsChanged([]);

  const flight = (view as unknown as { isometricFlight: { end: { target: THREE.Vector3 } } | null }).isometricFlight;
  assert.ok(flight, 'a correction is still in flight after the second shrink');
  assert.ok(
    Math.abs(flight!.end.target.x) <= OFFICE_HALF_X + 1e-6,
    `the flight's own endpoint already matches the newest bounds, not the first shrink's (x=${flight!.end.target.x})`,
  );
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
