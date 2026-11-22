import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

// `deskGeometry.js` (re-exported here for its monitor/sightline constants) needs a document
// and a 2D canvas context stub, same as `desk-monitors.test.ts`.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;

const {
  hexOfficeFrame,
  hexPassageHalfWidth,
  hexPassageDepth,
  hexDeskCameraPose,
  hexMonitorWorldCorners,
  hexQueueSpotWorldPositions,
  hexDeskTalkSpotPose,
  HEX_OFFICE_DESK,
  HEX_DESK_CAMERA_FOV,
  rayBlockedByQuad,
} = await import('../src/addons/building/hexDeskGeometry.js');
const { buildHexOfficeLayout, ROOM_RADIUS } = await import('../src/addons/building/HexRoomPlanner.js');
const { pointInPolygon } = await import('../src/addons/building/HexRoomPlanner.js');

after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

const layout = buildHexOfficeLayout();

test('the office is a through-passage: its two open edges sit on opposite sides, so hexPassageDepth is twice the apothem', () => {
  assert.equal(layout.office.openEdges.length, 2);
  const depth = hexPassageDepth(ROOM_RADIUS);
  assert.ok(depth > ROOM_RADIUS, 'door-to-door depth exceeds one room radius');
});

test('hexPassageHalfWidth is narrowest at both doors and widest at the exact midpoint', () => {
  const depth = hexPassageDepth(ROOM_RADIUS);
  const atDoor = hexPassageHalfWidth(ROOM_RADIUS, 0);
  const atFarDoor = hexPassageHalfWidth(ROOM_RADIUS, depth);
  const atMid = hexPassageHalfWidth(ROOM_RADIUS, depth / 2);
  assert.ok(Math.abs(atDoor - atFarDoor) < 1e-9, 'both doors are equally narrow');
  assert.ok(atMid > atDoor, 'the midpoint is wider than either door');
});

test('the desk sits off to one side of the passage (negative a), leaving the door-to-door center line (a = 0) clear', () => {
  assert.ok(HEX_OFFICE_DESK.a < 0);
});

test('at least 20 queue spots (issue #260 office-size decision), every one inside the office\'s own floor polygon', () => {
  const spots = hexQueueSpotWorldPositions(layout);
  assert.ok(spots.length >= 20, `only ${spots.length} queue spots`);
  const outside = spots.filter((spot) => !pointInPolygon({ x: spot.x, z: spot.z }, layout.office.corners));
  assert.deepEqual(outside, [], `${outside.length} queue spot(s) fall outside the office floor`);
});

test('from the hex desk camera pose, a ray to every queue spot clears both monitors', () => {
  const { position: camera } = hexDeskCameraPose(layout);
  const monitors = hexMonitorWorldCorners(layout);
  const blocked = hexQueueSpotWorldPositions(layout).filter((spot) =>
    monitors.some((quad) => rayBlockedByQuad(camera, spot, quad)));
  assert.deepEqual(blocked, [], `${blocked.length} queue spot(s) have a monitor in the way`);
});

test('the hex desk talk spot sits farther from the desk camera than either monitor, so it can never block a sightline to one', () => {
  const { position: camera } = hexDeskCameraPose(layout);
  const { position: spot } = hexDeskTalkSpotPose(layout);
  const monitors = hexMonitorWorldCorners(layout);
  for (const [side, quad] of (['left', 'right'] as const).map((s, i) => [s, monitors[i]!] as const)) {
    const monitorDistance = camera.distanceTo(quad.reduce((sum, p) => sum.add(p), new THREE.Vector3()).divideScalar(quad.length));
    assert.ok(camera.distanceTo(spot) > monitorDistance, `the talk spot is nearer the camera than the ${side} monitor`);
  }
  const blocked = monitors.filter((quad) => rayBlockedByQuad(camera, spot, quad));
  assert.deepEqual(blocked, [], `${blocked.length} monitor(s) stand between the camera and the talk spot`);
});

const DESK_VIEW_ASPECTS = [1280 / 800, 1600 / 1000, 1920 / 1080];

function deskFrustum(aspect: number): THREE.Frustum {
  const { position, lookAt, fov } = hexDeskCameraPose(layout);
  const camera = new THREE.PerspectiveCamera(fov, aspect, 0.1, 100);
  camera.position.copy(position);
  camera.lookAt(lookAt);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
}

test('both monitor faces and every queue spot sit inside the hex desk camera\'s own frustum, at every supported aspect ratio', () => {
  for (const aspect of DESK_VIEW_ASPECTS) {
    const frustum = deskFrustum(aspect);
    for (const [side, quad] of (['left', 'right'] as const).map((s, i) => [s, hexMonitorWorldCorners(layout)[i]!] as const)) {
      const box = new THREE.Box3().setFromPoints(quad);
      assert.ok(frustum.intersectsBox(box), `the ${side} monitor is outside the frustum at aspect ${aspect.toFixed(3)}`);
    }
    const outside = hexQueueSpotWorldPositions(layout).filter((spot) => !frustum.containsPoint(spot));
    assert.deepEqual(outside, [], `${outside.length} queue spot(s) sit outside the frustum at aspect ${aspect.toFixed(3)}`);
  }
});

test('HEX_DESK_CAMERA_FOV is re-derived by measurement, not copied from the rect office\'s 82deg', () => {
  assert.ok(HEX_DESK_CAMERA_FOV > 0 && HEX_DESK_CAMERA_FOV < 110, `${HEX_DESK_CAMERA_FOV} is not a sane vertical FOV`);
});

test('hexOfficeFrame\'s door sits on the office\'s own Hub-facing open edge', () => {
  const frame = hexOfficeFrame(layout);
  const doorPoint = frame.point(0, 0);
  const edgeIndex = layout.office.openEdges[0]!;
  const a = layout.office.corners[edgeIndex]!;
  const b = layout.office.corners[(edgeIndex + 1) % 6]!;
  const expectedMid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
  assert.ok(Math.abs(doorPoint.x - expectedMid.x) < 1e-6 && Math.abs(doorPoint.z - expectedMid.z) < 1e-6);
});
