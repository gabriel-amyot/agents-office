import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';

// Toon materials paint a gradient on a canvas at import time.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { buildHexOffice } = await import('../src/addons/building/HexRooms.js');
const { createToolCrib } = await import('../src/furniture/ToolCrib.js');
const { pointInPolygon, hexRoomCorners } = await import('../src/addons/building/HexRoomPlanner.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

/**
 * Issue #167 addendum: "a new object... very small thing... just do it", no trip mechanic this
 * round. Issue #260 step 7b item 4: the crib moved out of the rect hall into the hex Hub's own
 * accents zone — every one of the Hub's 6 corners was already spoken for, so the Hub, not the
 * hall, is where it lives now.
 */
test('the hub has one tool crib, with no shadow on any of its meshes (a small static prop, same rationale as a hat)', () => {
  const { group } = buildHexOffice();
  const accents = group.getObjectByName('hex-hub-accents')!;
  const crib = accents.getObjectByName('tool-crib')!;
  assert.ok(crib, 'expected one tool crib in the hub');
  let meshCount = 0;
  crib.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      meshCount++;
      assert.equal(object.castShadow, false, 'a crib piece casts no shadow, same as a hat');
      assert.equal(object.userData.figurePart, undefined, 'the crib is static furniture, not a per-agent figure part');
    }
  });
  assert.ok(meshCount > 0, 'expected at least one mesh');
});

test('createToolCrib returns a fresh group each call, never a shared instance', () => {
  assert.notEqual(createToolCrib(), createToolCrib());
});

/**
 * Issue #260 step 7b item 4: the Hub's own new furniture (the 2 test stations, the tool crib)
 * must actually sit inside the Hub's own hex interior — the same per-mesh inside-the-hex check
 * `tests/mission-rooms.test.ts`'s own war-room test already uses (`WALL_STRADDLE_TOLERANCE`: a
 * wall's own thickness legitimately straddles the hex boundary by half its width, never more).
 */
test('every hub test station and the tool crib stays inside the hub\'s own hex interior', () => {
  const WALL_STRADDLE_TOLERANCE = 0.2;
  const { group, layout } = buildHexOffice();
  const grown = hexRoomCorners(layout.hub.center, layout.hub.radius + WALL_STRADDLE_TOLERANCE);
  const failures: string[] = [];
  for (const zoneName of ['hex-hub-test', 'hex-hub-accents']) {
    const zone = group.getObjectByName(zoneName)!;
    zone.updateWorldMatrix(true, false);
    zone.traverse((object) => {
      if (!(object as THREE.Mesh).isMesh) return;
      const box = new THREE.Box3().setFromObject(object);
      const corners2D = [
        { x: box.min.x, z: box.min.z }, { x: box.min.x, z: box.max.z },
        { x: box.max.x, z: box.min.z }, { x: box.max.x, z: box.max.z },
      ];
      for (const corner of corners2D) {
        if (!pointInPolygon(corner, grown)) {
          failures.push(`${zoneName}: ${object.name || object.userData.piece || '(unnamed mesh)'} at ${JSON.stringify(box)} falls outside the hub (center ${JSON.stringify(layout.hub.center)}, radius ${layout.hub.radius})`);
          break;
        }
      }
    });
  }
  assert.deepEqual(failures, []);
});
