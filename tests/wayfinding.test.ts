import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { DOOR_WIDTH, slotFor, type Door, type Rect } from '../src/addons/building/RoomPlanner.js';
import type { Activity } from '../src/agents/ActivityAnimations.js';

// Furniture paints toon gradients on a canvas; room labels draw on a canvas too.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { createOffice } = await import('../src/scene/Office.js');
const { BuildingLayout } = await import('../src/addons/building/BuildingLayout.js');
const {
  buildWalls, buildCeiling, doorFrame, roomLabel, roomLabelLines, compactLabelLines, middleEllipsis, roomLabelPose, roomLabelBatchFor, WALL_HEIGHT, FIRST_PERSON_LABEL_Y, FIRST_PERSON_LABEL_HEIGHT,
  ISOMETRIC_LABEL_BOTTOM, CEILING_ZONE_NAME,
} = await import('../src/addons/building/rooms.js');
const { buildRealSizeOffice } = await import('./real-size-office.js');
const { IsometricController } = await import('../src/scene/IsometricCamera.js');
const { overviewBounds } = await import('../src/scene/OverviewCamera.js');
const { buildMissionRoom, testHexWarRoom } = await import('../src/addons/building/missionRooms.js');
const { applyCutaway, applyCeilingCut, OVERVIEW_WALL_HEIGHT } = await import('../src/scene/Cutaway.js');
const { StaticBatch } = await import('../src/scene/StaticMerge.js');
const { FrameLoop } = await import('../src/scene/FrameLoop.js');
const { addLighting } = await import('../src/scene/SceneSetup.js');
const { OFFICE } = await import('../src/utils/Constants.js');
const {
  LabelDetailController, ISOMETRIC_SIGN_ZOOM, FIRST_PERSON_SIGN_DISTANCE, roomLabelVisible, signVisible,
} = await import('../src/ui/LabelDetail.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

const center = (rect: Rect) => ({ x: (rect.minX + rect.maxX) / 2, z: (rect.minZ + rect.maxZ) / 2 });

function building() {
  const scene = new THREE.Scene();
  const storage = new Map<string, string>();
  // Issue #260 step 7b item 6: `createOffice` (the rect hall) never ran in production for the
  // 'building' layout (`main.ts`'s own `layoutId === 'activity' ? createOffice(scene) : new
  // Map()`, step 4) — an empty `Map` matches it; `BuildingLayout`'s own constructor builds the
  // hex structure regardless. The 'activity' layout's own `createOffice` behavior is still
  // exercised directly below ("the activity layout scene does not change in the overview").
  const layout = new BuildingLayout(scene, new Map(), {
    now: () => 0,
    storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v) },
  });
  const agent = (id: string, activity: Activity) => ({ id, activity });
  return { scene, layout, agent };
}

const labelsIn = (root: THREE.Object3D) => {
  const found: THREE.Object3D[] = [];
  root.traverse((object) => { if (object.userData.roomLabel !== undefined) found.push(object); });
  return found;
};

const missionRoom = (title = 'Office roadmap', sleeperCount = 3) => ({
  id: `room-${title}`, kind: 'mission' as const, title, state: 'open' as const,
  sleepers: Array.from({ length: sleeperCount }, (_, i) => ({ id: `tomb-${i}`, endedAt: '2026-11-18' })),
  walls: { statement: 'Ship it', docs: [], issues: [], kanban: [] },
});

// --- AC1: room labels ---

test('each room has one label above its center; in first person a small plate high in the room, below the wall top', () => {
  const slot = slotFor(1);
  // Issue #260 steps 2+3: `buildRoom` (the rect room builder) is gone; `roomLabel` is the one
  // piece of it this test actually needs, direct from `roomLabels.ts` (re-exported by `rooms.ts`).
  const label = roomLabel('Library', new THREE.Vector3(center(slot.rect).x, 0, center(slot.rect).z), slot.rect);
  const labels = labelsIn(label);
  assert.equal(labels.length, 1);
  assert.equal(label.name, 'room-label', 'a handle in the world: its scale is the plate size, so it scales with distance');
  assert.equal(label.userData.roomLabel, 'Library');
  assert.ok(Math.abs(label.position.x - center(slot.rect).x) < 1e-6 && Math.abs(label.position.z - center(slot.rect).z) < 1e-6);
  assert.equal(label.position.y, FIRST_PERSON_LABEL_Y);
  assert.ok(label.scale.y <= FIRST_PERSON_LABEL_HEIGHT + 1e-6, `plate height ${label.scale.y}`);
  assert.notEqual(label.userData.onTop, true, 'walls in front hide the label in first person (depth test)');
  assert.ok(FIRST_PERSON_LABEL_Y + label.scale.y / 2 < WALL_HEIGHT, 'the whole label is below the wall top');
  assert.ok(FIRST_PERSON_LABEL_Y - label.scale.y / 2 > 1.8, 'the plate is above head height, so it does not fill the doorway');
});

test('label lines: short lines for the default overview, a " · " starts a new line', () => {
  assert.deepEqual(roomLabelLines('DESKS · WS10', 7), ['DESKS', 'WS10']);
  assert.deepEqual(roomLabelLines('YOUR OFFICE', 7), ['YOUR', 'OFFICE']);
  assert.deepEqual(roomLabelLines('LOUNGE 2', 7), ['LOUNGE', '2']);
  assert.deepEqual(roomLabelLines('LIBRARY', 7), ['LIBRARY']);
  assert.deepEqual(roomLabelLines('MISSION ROADMAP FOR THE FORK', 7), ['MISSION', 'ROADMAP…']);
  assert.deepEqual(compactLabelLines('MISSION ROADMAP 3'), ['MISSION', '…3']);
  assert.deepEqual(compactLabelLines('MEDIA PLAN SALESFORCE PERSISTENCE'), ['MEDIA', '…PER…CE']);
  assert.deepEqual(compactLabelLines('LOUNGE 2'), ['LOUNGE', '2']);
  assert.deepEqual(roomLabelLines('MISSION ROADMAP 3', 16), ['MISSION ROADMAP', '3']);
});

test('middleEllipsis cuts a too-long word in the middle, not the front', () => {
  assert.equal(middleEllipsis('LIBRARY', 7), 'LIBRARY', 'fits, unchanged');
  assert.equal(middleEllipsis('AGENT-83-REVIEW', 7), 'AGE…IEW');
  assert.equal(middleEllipsis('', 7), '');
  assert.equal(middleEllipsis('AB', 1), '…', 'no room for even one real character');
  assert.equal(middleEllipsis('ABCDE', 2), 'A…', 'a one-character budget after the ellipsis keeps only the head');
});

test('middleEllipsis keeps a surrogate pair whole, even at the cut boundary', () => {
  // A supplementary character (an emoji) is two UTF-16 units; slicing by index
  // alone can split the pair and leave a lone surrogate. Split by code point instead.
  const cut = middleEllipsis('AGENT-NAME\uD83D\uDE80XY', 7);
  const lonelySurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.equal(lonelySurrogate.test(cut), false, `no lone surrogate in ${JSON.stringify(cut)}`);
  assert.ok(Array.from(cut).length <= 7);
});

test('issue #87 AC3: two compact chips that share their first 9 characters still differ', () => {
  // Both names share the word "AGENT" and a numbered mission slug, the real shape of
  // two mission rooms today (see docs/roadmap.md item 20's examples).
  const reviewFace = compactLabelLines('AGENT 83 BUILD REVIEW');
  const launcherFace = compactLabelLines('AGENT 83 BUILD LAUNCHER');
  assert.notDeepEqual(reviewFace, launcherFace);

  // The exact collision from before this fix: two last words sharing a 5-character
  // prefix ("PERSI") both front-cut to the identical "…PERSI…". Confirmed against the
  // pre-fix compactLabelLines: both produced the same string, so this pair is a real
  // regression check, not just two names that already read apart.
  const persistence = compactLabelLines('MEDIA PLAN SALESFORCE PERSISTENCE');
  const persistage = compactLabelLines('MEDIA PLAN SALESFORCE PERSISTAGE');
  assert.notDeepEqual(persistence, persistage);
});

test('in the overview a plate grows with the zoom distance but never gets wider than a room', () => {
  const near = roomLabelPose({ viewMode: 'isometric', zoomDistance: 20, detail: false }, 2);
  const far = roomLabelPose({ viewMode: 'isometric', zoomDistance: 80, detail: false }, 2);
  assert.ok(far.height > near.height * 1.9, 'twice the distance, about twice the size');
  assert.ok(near.y - near.height / 2 >= ISOMETRIC_LABEL_BOTTOM - 1e-6 && near.onTop);
  const wide = roomLabelPose({ viewMode: 'isometric', zoomDistance: 200, detail: false }, 6);
  assert.ok(wide.width <= 12 - 1 + 1e-6, `width ${wide.width}`);
  const fp = roomLabelPose({ viewMode: 'first-person', zoomDistance: 200, detail: true }, 2);
  assert.equal(fp.onTop, false);
  assert.equal(fp.height, FIRST_PERSON_LABEL_HEIGHT);
});

/** Screen rect (px) of a sprite for a perspective or an orthographic camera, viewport 1600x1000. */
function screenRect(sprite: THREE.Object3D, camera: THREE.PerspectiveCamera | THREE.OrthographicCamera, size = { w: 1600, h: 1000 }) {
  const center = sprite.getWorldPosition(new THREE.Vector3());
  let pxPerUnit: number;
  if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
    const perspective = camera as THREE.PerspectiveCamera;
    const view = center.clone().applyMatrix4(camera.matrixWorldInverse);
    const depth = -view.z;
    pxPerUnit = size.h / (2 * depth * Math.tan(THREE.MathUtils.degToRad(perspective.fov) / 2));
  } else {
    const ortho = camera as THREE.OrthographicCamera;
    pxPerUnit = (size.h * ortho.zoom) / (ortho.top - ortho.bottom);
  }
  const ndc = center.clone().project(camera);
  const x = (ndc.x + 1) / 2 * size.w;
  const y = (1 - ndc.y) / 2 * size.h;
  const w = sprite.scale.x * pxPerUnit;
  const h = sprite.scale.y * pxPerUnit;
  return { left: x - w / 2, right: x + w / 2, top: y - h / 2, bottom: y + h / 2, height: h };
}

test('real size, default isometric view at 1600x1000: every room label plate is at least 22 px tall and no two overlap', () => {
  const { scene } = buildRealSizeOffice();
  scene.updateMatrixWorld();
  const camera = new THREE.OrthographicCamera();
  const isometric = new IsometricController();
  isometric.frame(overviewBounds(scene), 1600 / 1000);
  isometric.applyTo(camera, 1600 / 1000, 60);
  camera.updateMatrixWorld();
  const canvas = dom.window.document.createElement('canvas');
  const zoomDistance = isometric.equivalentDistance(60);
  const controller = new LabelDetailController({
    agents: () => [], camera, canvas, keys: dom.window, scene,
    viewMode: () => 'isometric', zoomDistance: () => zoomDistance, pick: () => null, selected: () => null,
  });
  controller.refresh();
  scene.updateMatrixWorld();
  const labels = labelsIn(scene);
  // Issue #260 steps 2+3: library + 9 mission rooms. The rect office (and its "Your office"
  // label, `addRoom`) is gone. Issue #260 step 7b item 4: the hex Office and the Hub each get
  // their own label now ("Your office", "Hub") — the wayfinding gap the steps 2+3 comment above
  // used to flag, closed. The retired 'desks'/'lab'/'lounge' overflow kinds used to add up to
  // 14 more labels here.
  assert.equal(labels.length, 12);
  const rects = labels.map((label) => ({ text: label.userData.roomLabel as string, rect: screenRect(label, camera) }));
  console.log(`room label plates: min ${Math.min(...rects.map((r) => r.rect.height)).toFixed(1)} px at zoom ${zoomDistance.toFixed(1)}`);
  for (const { text, rect } of rects) assert.ok(rect.height >= 22, `${text}: ${rect.height.toFixed(1)} px at zoom ${zoomDistance.toFixed(1)}`);
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i].rect;
      const b = rects[j].rect;
      const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      assert.ok(!overlap, `${rects[i].text} overlaps ${rects[j].text}`);
    }
  }
  // The default isometric view shows the compact face; a war room title fits short lines
  const war = labels.find((label) => label.userData.roomLabel === 'Mission 3')!;
  assert.deepEqual(war.userData.labelLines, ['MISSION', '3']);
  // Each text line is readable too, not only the plate
  for (const { text, rect } of rects) {
    const lines = (labels.find((label) => label.userData.roomLabel === text)!.userData.labelLines as string[]).length;
    assert.ok(rect.height / lines >= 11, `${text}: ${(rect.height / lines).toFixed(1)} px per line`);
  }
  for (const label of labels) assert.equal(label.userData.onTop, true, 'drawn on top in the isometric view');
});

test('every room label of the scene draws in one instanced call; a hidden label gets scale 0', () => {
  const { scene, layout } = building();
  layout.syncWorldRooms([missionRoom('A'), missionRoom('B')]);
  const batch = roomLabelBatchFor(scene);
  const labels = labelsIn(scene);
  assert.equal(batch.labels.length, labels.length);
  assert.equal(batch.mesh.count, labels.length);
  let batches = 0;
  scene.traverse((object) => { if (object.name === 'room-label-batch') batches++; });
  assert.equal(batches, 1, 'one mesh, one draw call');
  const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 500);
  camera.position.set(0, 1.6, 0);
  camera.updateMatrixWorld();
  const controller = new LabelDetailController({
    agents: () => [], camera, canvas: dom.window.document.createElement('canvas'), keys: dom.window, scene,
    viewMode: () => 'first-person', zoomDistance: () => 0, pick: () => null, selected: () => null,
  });
  const inside = labels[0];
  const rect = inside.userData.roomRect as Rect;
  camera.position.set(center(rect).x, 1.6, center(rect).z);
  camera.updateMatrixWorld();
  controller.refresh();
  scene.updateMatrixWorld();
  batch.sync();
  const matrix = new THREE.Matrix4();
  const scale = new THREE.Vector3();
  batch.mesh.getMatrixAt(batch.labels.indexOf(inside), matrix);
  scale.setFromMatrixScale(matrix);
  assert.equal(scale.x, 0, 'the room you stand in: hidden');
  const other = batch.labels.find((label) => label !== inside)!;
  batch.mesh.getMatrixAt(batch.labels.indexOf(other), matrix);
  const position = new THREE.Vector3().setFromMatrixPosition(matrix);
  // Issue #259: the hex structure (and so its Library label, a candidate for `other`) sits a
  // few hundred units from the origin; the instance matrix's own storage
  // (`THREE.InstancedBufferAttribute`, a `Float32Array`) only carries single-precision at that
  // magnitude, so a position round-tripped through it drifts by a few times 1e-6, not the
  // double-precision 1e-6 this bound assumed when every label lived near the origin.
  assert.ok(position.distanceTo(other.getWorldPosition(new THREE.Vector3())) < 1e-4, 'an instance stands at its label');
  assert.ok(Math.abs(new THREE.Vector3().setFromMatrixScale(matrix).y - other.scale.y) < 1e-6, 'with the plate size');
  assert.equal((batch.mesh.material as THREE.ShaderMaterial).depthTest, true, 'walls hide labels in first person');
});

test('a room label shows its full name when zoomed in or with labels: all', () => {
  const scene = new THREE.Scene();
  const room = buildMissionRoom(missionRoom('Roadmap for the fork'), 0, testHexWarRoom(0));
  scene.add(room.group);
  const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 500);
  camera.position.set(0, 60, 40);
  camera.updateMatrixWorld();
  const state = { zoom: 80 };
  let changes = 0;
  const controller = new LabelDetailController({
    agents: () => [], camera, canvas: dom.window.document.createElement('canvas'), keys: dom.window, scene, changed: () => { changes++; },
    viewMode: () => 'isometric', zoomDistance: () => state.zoom, pick: () => null, selected: () => null,
  });
  controller.refresh();
  const [label] = labelsIn(room.group);
  assert.deepEqual(label.userData.labelLines, ['ROADMAP', '…FORK']);
  assert.equal(changes, 1, 'a label change asks for a frame');
  controller.refresh();
  assert.equal(changes, 1, 'no change, no frame');
  state.zoom = ISOMETRIC_SIGN_ZOOM;
  controller.refresh();
  assert.deepEqual(label.userData.labelLines, ['ROADMAP FOR THE', 'FORK']);
});

test('the sign list is collected once, and again after sceneChanged', () => {
  const scene = new THREE.Scene();
  scene.add(buildMissionRoom(missionRoom('One'), 0, testHexWarRoom(0)).group);
  const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 500);
  camera.position.set(0, 60, 40);
  camera.updateMatrixWorld();
  let traversals = 0;
  const traverse = scene.traverse.bind(scene);
  scene.traverse = (callback) => { traversals++; traverse(callback); };
  const controller = new LabelDetailController({
    agents: () => [], camera, canvas: dom.window.document.createElement('canvas'), keys: dom.window, scene,
    viewMode: () => 'isometric', zoomDistance: () => 80, pick: () => null, selected: () => null,
  });
  controller.refresh();
  controller.refresh();
  controller.refresh();
  assert.equal(traversals, 1);
  const late = buildMissionRoom(missionRoom('Two'), 1, testHexWarRoom(1));
  scene.add(late.group);
  controller.sceneChanged();
  controller.refresh();
  assert.equal(traversals, 2);
  assert.equal(labelsIn(late.group)[0].userData.onTop, true, 'the new room label gets the overview pose');
});

// Issue #260 steps 2+3: BuildingLayout no longer builds a rect room (`buildRoom`, the only
// thing that ever added a "small door sign chip", is gone). Nothing replaces it, so there is
// no room construction left to assert a missing chip on.

test('every room of the building, and every war room, gets a label', () => {
  const { scene, layout } = building();
  layout.syncWorldRooms([missionRoom('One'), missionRoom('Two')]);
  const texts = labelsIn(scene).map((label) => label.userData.roomLabel);
  // Issue #260 steps 2+3: the rect office (`addRoom('office')`) used to be the only thing that
  // ever labeled "Your office" — gone now. Issue #260 step 7b item 4: `BuildingLayout`'s own
  // `addHexOfficeAndHubLabels` replaces it, plus a new "Hub" plate for the room that never had
  // one at all.
  assert.deepEqual(texts.sort(), ['Hub', 'Library', 'One', 'Two', 'Your office'].sort());
});

test('a war room label follows the mission title', () => {
  const room = buildMissionRoom(missionRoom('Old title'), 0, testHexWarRoom(0));
  room.update({ ...missionRoom('Old title'), title: 'New title' });
  assert.equal(labelsIn(room.group)[0].userData.roomLabel, 'New title');
});

test('a room label hides in first person while the camera is inside its room, so it does not block the view', () => {
  assert.equal(roomLabelVisible({ viewMode: 'first-person', cameraInside: true }), false);
  assert.equal(roomLabelVisible({ viewMode: 'first-person', cameraInside: false }), true);
  assert.equal(roomLabelVisible({ viewMode: 'isometric', cameraInside: true }), true);
});

test('the label controller applies the room label rule from the camera position', () => {
  const scene = new THREE.Scene();
  const slot = slotFor(1);
  const label = roomLabel('Library', new THREE.Vector3(center(slot.rect).x, 0, center(slot.rect).z), slot.rect);
  scene.add(label);
  assert.deepEqual(label.userData.roomRect, slot.rect);
  const camera = new THREE.PerspectiveCamera(60, 16 / 10, 0.1, 500);
  const inside = center(slot.rect);
  camera.position.set(inside.x, 1.6, inside.z);
  camera.updateMatrixWorld();
  let viewMode: 'isometric' | 'first-person' = 'first-person';
  const controller = new LabelDetailController({
    agents: () => [], camera, canvas: dom.window.document.createElement('canvas'), keys: dom.window, scene,
    viewMode: () => viewMode, zoomDistance: () => 40, pick: () => null, selected: () => null,
  });
  controller.refresh();
  assert.equal(label.visible, false, 'inside the room in first person');
  camera.position.set(0, 1.6, 0);
  camera.updateMatrixWorld();
  controller.refresh();
  assert.equal(label.visible, true, 'from the hall');
  camera.position.set(inside.x, 1.6, inside.z);
  viewMode = 'isometric';
  controller.refresh();
  assert.equal(label.visible, true, 'always in the overview');
});

// Issue #260 steps 2+3: `roomTitle` (and the numbered-waiting-room behavior it gave) is gone
// along with `addRoom` — the hex office never rents a second one, so there is no later office
// left to number.

// --- AC2: door frames ---

function assertFrameAt(frame: THREE.Object3D, rect: Rect, door: Door, color: number) {
  const meshes = frame.children.filter((child): child is THREE.Mesh => child instanceof THREE.Mesh);
  assert.equal(meshes.length, 3, 'two posts and a lintel');
  const horizontal = door.side === 'north' || door.side === 'south';
  const wallLine = { north: rect.minZ, south: rect.maxZ, west: rect.minX, east: rect.maxX }[door.side];
  const along = (mesh: THREE.Mesh) => (horizontal ? mesh.position.x : mesh.position.z);
  const across = (mesh: THREE.Mesh) => (horizontal ? mesh.position.z : mesh.position.x);
  for (const mesh of meshes) {
    assert.ok(Math.abs(across(mesh) - wallLine) < 1e-6, 'on the door wall');
    assert.equal((mesh.material as THREE.MeshToonMaterial).color.getHex(), color, 'in the room floor color');
  }
  const posts = meshes.filter((mesh) => mesh.name === 'door-post');
  const lintel = meshes.find((mesh) => mesh.name === 'door-lintel')!;
  assert.equal(posts.length, 2);
  const offsets = posts.map((post) => along(post) - door.at).sort((a, b) => a - b);
  assert.ok(offsets[0] < -DOOR_WIDTH / 2 + 0.2 && offsets[0] > -DOOR_WIDTH / 2 - 0.3, `left post at the gap edge (${offsets[0]})`);
  assert.ok(Math.abs(offsets[0] + offsets[1]) < 1e-6, 'posts are symmetric');
  assert.ok(Math.abs(along(lintel) - door.at) < 1e-6, 'lintel centered on the door');
  assert.ok(lintel.position.y > Math.max(...posts.map((post) => post.position.y)), 'lintel above the posts');
}

test('a room door has a frame of two posts and a lintel in the room floor color', () => {
  const slot = slotFor(0);
  // Issue #260 steps 2+3: `buildRoom`/`roomFloorColor` (the rect room builder and its own
  // floor-tint lookup) are gone; `doorFrame` is the one piece of it this test actually needs,
  // direct from `rooms.ts` — any color works, `doorFrame` only ever paints the frame with it.
  const officeFloorColor = 0x8a6f5a;
  const frame = doorFrame(slot.rect, slot.door, officeFloorColor);
  assertFrameAt(frame, slot.rect, slot.door, officeFloorColor);
});

// Issue #260 steps 2+3: the rect office never rents a second room past its own fixed queue
// capacity any more (`addRoom` is gone; overflow grows an office-interior spiral spot instead,
// `BuildingLayout.allocateOverflowQueueStation` — no new door, no new frame). A hex war room
// never had a door frame either way (round 7: "rooms without doors"). There is no "every
// doorway, outer rings included" case left for this suite to exercise.

// --- AC3: cut-away walls ---

/** Run the static merge and the cutaway once, as a frame of the render loop does. */
function frameOf(scene: THREE.Scene, statics: InstanceType<typeof StaticBatch>, fromAbove: boolean): boolean {
  scene.updateMatrixWorld();
  statics.update();
  return applyCutaway(scene, fromAbove);
}

/** The highest point of every drawn (camera layer) mesh under a zone container that the overview lowers. */
function drawnWallTops(scene: THREE.Scene, zone: 'walls' | 'doors' = 'walls'): number[] {
  const tops: number[] = [];
  const camera = new THREE.Layers();
  for (const container of scene.children) {
    if (container.userData.overviewLower === undefined) continue;
    if ((container.name === 'static-batch-door-frames') !== (zone === 'doors')) continue;
    container.traverseVisible((object) => {
      if ((object as THREE.Mesh).isMesh && object.layers.test(camera)) tops.push(topOf(object));
    });
  }
  return tops;
}

const topOf = (mesh: THREE.Object3D) => new THREE.Box3().setFromObject(mesh).max.y;

test('issue #176: a room\'s walls (office, library, every other kind) are as tall as the main room\'s', () => {
  assert.equal(WALL_HEIGHT, OFFICE.height, 'room walls share the main room\'s wall height constant');
  const slot = slotFor(1);
  // Issue #260 steps 2+3: `buildRoom` is gone; `buildWalls` (still exported, the library scene
  // uses it too) is the one piece of it this test actually needs.
  const wallsGroup = buildWalls(slot.rect, [slot.door]);
  const walls: THREE.Mesh[] = [];
  wallsGroup.traverse((object) => { if ((object as THREE.Mesh).isMesh) walls.push(object as THREE.Mesh); });
  assert.ok(walls.length > 0, 'the room has wall meshes');
  for (const wall of walls) assert.ok(Math.abs(topOf(wall) - OFFICE.height) < 1e-6, `${wall.parent?.name ?? 'wall'} top at ${topOf(wall)}, expected ${OFFICE.height}`);
});

test('buildCeiling() makes a ceiling mesh at the given height, merged into the shared ceiling zone (review, #184 round 2)', () => {
  const rect = slotFor(1).rect;
  const ceiling = buildCeiling(rect);
  assert.ok(Math.abs(ceiling.position.y - WALL_HEIGHT) < 1e-6, `ceiling at ${ceiling.position.y}, expected ${WALL_HEIGHT}`);
  assert.ok(Math.abs(ceiling.position.x - (rect.minX + rect.maxX) / 2) < 1e-6 && Math.abs(ceiling.position.z - (rect.minZ + rect.maxZ) / 2) < 1e-6, 'centered over the room');
  const custom = buildCeiling(rect, 9);
  assert.equal(custom.position.y, 9, 'a given height overrides the main room\'s own constant');
});

test('every room\'s ceiling merges into one mesh, and toggling that merged mesh triggers no rebuild and ejects nothing (review, #184 round 2)', () => {
  const scene = new THREE.Scene();
  // Issue #260 steps 2+3: `buildRoom` is gone; two bare `buildCeiling` meshes are all this
  // merge test actually needs (it already marks itself into `CEILING_ZONE`).
  scene.add(buildCeiling(slotFor(1).rect), buildCeiling(slotFor(2).rect));

  const statics = new StaticBatch(scene);
  statics.update();
  const merged = scene.getObjectByName(CEILING_ZONE_NAME);
  assert.ok(merged, 'the two rooms\' ceilings merged into one zone mesh');
  assert.equal(merged!.children.length, 1, 'one merged ceiling mesh for both rooms together');

  // Toggling the merged mesh's own visible, the way applyCeilingCut does on every view switch,
  // never touches a source's own visible: nothing about the batch's signature changes, so
  // neither a direct rebuild call nor the frame loop's own update should ever rebuild it.
  assert.equal(applyCeilingCut(scene, [], true), true, 'the merged ceiling mesh hides');
  assert.equal(merged!.visible, false);
  assert.equal(statics.update(), false, 'hiding the merged ceiling triggers no batch rebuild');
  assert.equal(applyCeilingCut(scene, [], false), true, 'the merged ceiling mesh shows again');
  assert.equal(merged!.visible, true);
  assert.equal(statics.update(), false, 'showing it again triggers no batch rebuild either');
});

// Issue #260 steps 2+3: `sourceWalls` only ever scanned the rect hall's and rect rooms' own
// wall/door-frame names (`room-walls`, `building-hall-walls`, `door-frame`) — all gone now,
// along with `addRoom`/`rebuildHallWalls`/`hideHallSideWalls`. Every wall left (the hex Hub,
// Office, Library and every war room) merges through `HexRooms.ts`'s own `hex-walls` zone,
// already covered by `tests/hex-rooms.test.ts`'s "hex walls carry an overview cutaway height".
test('the hex structure\'s own walls draw merged, from a cutaway zone the overview lowers', () => {
  const { scene } = building();
  const statics = new StaticBatch(scene);
  frameOf(scene, statics, false);
  const tops = drawnWallTops(scene);
  assert.ok(tops.length > 0, 'the walls draw from cutaway zones');
  assert.ok(Math.max(...tops) >= WALL_HEIGHT - 1e-6, 'first person keeps full walls');
});

test('the overview lowers the merged walls so the room floors show; first person restores full walls', () => {
  const { scene } = building();
  const statics = new StaticBatch(scene);
  frameOf(scene, statics, false);
  const before = drawnWallTops(scene);

  assert.equal(frameOf(scene, statics, true), true, 'the cutaway reports a change');
  for (const top of drawnWallTops(scene)) assert.ok(top <= OVERVIEW_WALL_HEIGHT + 1e-6, `wall top ${top}`);
  assert.equal(frameOf(scene, statics, true), false, 'a second overview frame changes nothing');

  frameOf(scene, statics, false);
  assert.deepEqual(drawnWallTops(scene), before);
});

test('walls built while the overview is on are lowered in the same frame, and stand at full height after it', () => {
  const { scene, layout, agent } = building();
  const statics = new StaticBatch(scene);
  frameOf(scene, statics, true);
  for (let i = 0; i < 6 + 9; i++) layout.seatFor(agent(`idle-${i}`, 'idle'), null);
  layout.syncWorldRooms([missionRoom('Late')]);
  frameOf(scene, statics, true);
  for (const top of drawnWallTops(scene)) assert.ok(top <= OVERVIEW_WALL_HEIGHT + 1e-6, `wall top ${top}`);
  frameOf(scene, statics, false);
  const tops = drawnWallTops(scene);
  assert.ok(Math.max(...tops) <= OFFICE.height + 1e-6, `no stretched wall (${Math.max(...tops)})`);
  assert.ok(Math.max(...tops) >= WALL_HEIGHT - 1e-6);
});

test('the activity layout scene does not change in the overview', () => {
  const scene = new THREE.Scene();
  createOffice(scene);
  const original: THREE.Object3D[] = [];
  scene.traverse((object) => original.push(object));
  const snapshot = () => original.map((object) => `${object.uuid}:${object.visible}:${object.scale.toArray()}:${object.position.toArray()}`);
  const before = snapshot();
  const statics = new StaticBatch(scene);
  frameOf(scene, statics, false);
  const merged = snapshot();
  assert.equal(frameOf(scene, statics, true), false);
  assert.deepEqual(snapshot(), merged);
  assert.equal(before.length, merged.length);
});

test('the render loop applies the cutaway in the frame of the mode switch and redraws the shadows', () => {
  const { scene } = building();
  addLighting(scene);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(-12, 5.5, 11);
  let mode: 'first-person' | 'isometric' = 'first-person';
  let renders = 0;
  const renderer = {
    render: () => { renders++; }, info: { render: { calls: 0, triangles: 0 }, reset: () => undefined },
    shadowMap: { needsUpdate: false, type: THREE.PCFSoftShadowMap }, getPixelRatio: () => 1, setPixelRatio: () => undefined,
  };
  const loop = new FrameLoop({
    scene, camera, renderer: renderer as never, labelRenderer: { render: () => undefined },
    update: () => undefined, figures: () => [], mode: () => mode,
  });
  loop.frame(0);
  mode = 'isometric';
  const before = renders;
  loop.frame(1000);
  assert.equal(renders, before + 1);
  for (const top of drawnWallTops(scene)) assert.ok(top <= OVERVIEW_WALL_HEIGHT + 1e-6, `wall top ${top}`);
});

// Issue #260 steps 2+3: `buildWalls`'s own `hideSides` parameter (the piece that fed
// `overview-hidden-walls`) had exactly one caller — `rebuildHallWalls`, the rect hall's own
// south/west sides — now gone along with it; nothing in production passes `hideSides` any
// more. `static-merge.test.ts`'s own "a root without a zone merges in place and follows its own
// visibility" already covers the generic mechanism `markStatic`'s `hiddenFromAbove` uses.
//
// `markDoorCutaway` (the door-frame cutaway zone `static-batch-door-frames`, this suite's own
// "in the overview door frames drop to 1.2 m" test used) is gone too — a hex war room has no
// door frame at all (round 7: "rooms without doors"), and the rect rooms that used to have one
// are gone along with `addRoom`.

test('the render loop redraws the shadows when only the cutaway changes', () => {
  const { scene } = building();
  addLighting(scene);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(-12, 5.5, 11);
  let renders = 0;
  const renderer = {
    render: () => { renders++; }, info: { render: { calls: 0, triangles: 0 }, reset: () => undefined },
    shadowMap: { needsUpdate: false, type: THREE.PCFSoftShadowMap }, getPixelRatio: () => 1, setPixelRatio: () => undefined,
  };
  const loop = new FrameLoop({
    scene, camera, renderer: renderer as never, labelRenderer: { render: () => undefined },
    update: () => undefined, figures: () => [], mode: () => 'isometric',
  });
  loop.frame(0);
  loop.frame(100);
  loop.frame(200);
  // A zone that stands at full height again (for example built in the overview): only the
  // cutaway changes. Issue #260 steps 2+3: the rect hall's own `hall-walls` zone is gone along
  // with `rebuildHallWalls`; the hex structure's own `hex-walls` zone (nested inside
  // `hexOffice.group`, not a direct scene child like the rect hall's was) is the one left.
  const zone = scene.getObjectByName('static-batch-hex-walls')!;
  zone.scale.y = 1;
  zone.updateMatrixWorld(true);
  renderer.shadowMap.needsUpdate = false;
  const before = renders;
  loop.frame(300);
  assert.equal(renders, before + 1, 'a frame renders');
  assert.equal(renderer.shadowMap.needsUpdate, true, 'the shadow maps redraw');
  assert.ok(zone.scale.y < 1);
});

// --- AC5: quieter mission signs ---

const view = (overrides: Partial<{ mode: 'smart' | 'all'; viewMode: 'isometric' | 'first-person'; zoomDistance: number }> = {}) =>
  ({ mode: 'smart' as const, viewMode: 'isometric' as const, zoomDistance: ISOMETRIC_SIGN_ZOOM + 20, ...overrides });

test('a mission sign shows only when you zoom in or hover; the past sessions sign only on hover', () => {
  const far = FIRST_PERSON_SIGN_DISTANCE + 5;
  assert.equal(signVisible({ hovered: false, distance: far, hoverOnly: false }, view()), false);
  assert.equal(signVisible({ hovered: false, distance: far, hoverOnly: false }, view({ zoomDistance: ISOMETRIC_SIGN_ZOOM })), true);
  assert.equal(signVisible({ hovered: true, distance: far, hoverOnly: false }, view()), true);
  assert.equal(signVisible({ hovered: false, distance: far, hoverOnly: true }, view({ zoomDistance: 3 })), false);
  assert.equal(signVisible({ hovered: true, distance: far, hoverOnly: true }, view()), true);
  // First person: near signs show, far ones do not
  assert.equal(signVisible({ hovered: false, distance: FIRST_PERSON_SIGN_DISTANCE, hoverOnly: false }, view({ viewMode: 'first-person' })), true);
  assert.equal(signVisible({ hovered: false, distance: far, hoverOnly: false }, view({ viewMode: 'first-person' })), false);
  // Labels: all shows every sign
  assert.equal(signVisible({ hovered: false, distance: far, hoverOnly: true }, view({ mode: 'all' })), true);
});

test('maxDistance overrides FIRST_PERSON_SIGN_DISTANCE in first person, for a sign meant to read from anywhere in its own room (round 7, #214: the library\'s shelf labels)', () => {
  const beyondDefault = FIRST_PERSON_SIGN_DISTANCE + 5;
  // Without maxDistance: unchanged, the old default still applies.
  assert.equal(signVisible({ hovered: false, distance: beyondDefault, hoverOnly: false }, view({ viewMode: 'first-person' })), false);
  // With a wider maxDistance: visible past the old default, right up to the override.
  assert.equal(signVisible({ hovered: false, distance: beyondDefault, hoverOnly: false, maxDistance: 20 }, view({ viewMode: 'first-person' })), true);
  assert.equal(signVisible({ hovered: false, distance: 21, hoverOnly: false, maxDistance: 20 }, view({ viewMode: 'first-person' })), false);
  // maxDistance only ever widens or narrows the first-person distance check; the isometric
  // view keeps its own separate zoom-based rule regardless (ISOMETRIC_SIGN_ZOOM, unaffected).
  assert.equal(signVisible({ hovered: false, distance: beyondDefault, hoverOnly: false, maxDistance: 20 }, view({ zoomDistance: ISOMETRIC_SIGN_ZOOM + 1 })), false);
});

test('war room signs are marked as detail signs with their room', () => {
  const hexRoom = testHexWarRoom(0);
  const room = buildMissionRoom(missionRoom('Roadmap', 2), 0, hexRoom);
  const signs = room.group.children.filter((child): child is CSS2DObject => child instanceof CSS2DObject);
  assert.ok(signs.length >= 2);
  // Issue #259: the sign's own `rect` is the hex room's AABB now, the same conservative bound
  // `HexRooms.ts`'s library marker and `missionRooms.ts`'s own `hexBounds` helper both use.
  const xs = hexRoom.corners.map((c) => c.x);
  const zs = hexRoom.corners.map((c) => c.z);
  const expectedRect = { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
  for (const sign of signs) {
    assert.deepEqual(sign.userData.detailSign.rect, expectedRect);
    assert.equal(sign.element.dataset.sign, 'mission');
  }
  const sleepers = signs.find((sign) => /past session/.test(sign.element.textContent ?? ''))!;
  assert.equal(sleepers.userData.detailSign.hoverOnly, true);
});

test('the label controller hides war room signs in the default overview and shows them when zoomed in', () => {
  const scene = new THREE.Scene();
  const room = buildMissionRoom(missionRoom('Roadmap', 2), 0, testHexWarRoom(0));
  scene.add(room.group);
  const camera = new THREE.PerspectiveCamera(60, 16 / 10, 0.1, 500);
  camera.position.set(0, 60, 40);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const canvas = dom.window.document.createElement('canvas');
  const state = { zoom: ISOMETRIC_SIGN_ZOOM + 30 };
  const controller = new LabelDetailController({
    agents: () => [], camera, canvas, keys: dom.window, scene,
    viewMode: () => 'isometric', zoomDistance: () => state.zoom, pick: () => null, selected: () => null,
  });
  const signs = room.group.children.filter((child): child is CSS2DObject => child instanceof CSS2DObject);
  controller.refresh();
  assert.ok(signs.every((sign) => sign.element.style.visibility === 'hidden'));
  state.zoom = ISOMETRIC_SIGN_ZOOM - 1;
  controller.refresh();
  const title = signs.find((sign) => sign.element.textContent === 'Roadmap')!;
  assert.equal(title.element.style.visibility, '');
  const sleepers = signs.find((sign) => /past session/.test(sign.element.textContent ?? ''))!;
  assert.equal(sleepers.element.style.visibility, 'hidden', 'past sessions wait for a hover');
});

// Issue #260 steps 2+3: the rect office (and its "You" sign, `furnishing.ts`'s `furnishOffice`)
// is gone; the hex office's own desk has had the same sign since step 2 (`HexRooms.ts`'s
// `buildHexOfficeDesk`) — this is now the only "You" sign left, so it is what must still
// declutter in the overview.
test('the "You" sign at the user desk is a detail sign too, so it does not cover the queue in the overview', () => {
  const { layout, scene } = building();
  const desk = scene.getObjectByName('hex-office-desk')!;
  const you = desk.children.find((child): child is CSS2DObject => child instanceof CSS2DObject && child.element.textContent === 'You')!;
  assert.ok(you, 'the hex desk has its own "You" sign');
  const detail = you.userData.detailSign as { rect: Rect; hoverOnly: boolean };
  assert.equal(detail.hoverOnly, false);
  const officeView = layout.roomView('office')!;
  assert.deepEqual([detail.rect.minX, detail.rect.maxX, detail.rect.minZ, detail.rect.maxZ],
    [officeView.bounds.min.x, officeView.bounds.max.x, officeView.bounds.min.z, officeView.bounds.max.z]);
});
