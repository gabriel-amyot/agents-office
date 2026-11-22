import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildHexOfficeLayout,
  hexSurfaceHeightAt,
  hexWallColliders,
  hubFurnitureSpots,
  hubOverflowIdleSpot,
  libraryOverflowResearchingSpot,
  pointInPolygon,
  WALKWAY_HEIGHT,
} from '../src/addons/building/HexRoomPlanner.js';
import { HALL } from '../src/addons/building/RoomPlanner.js';

test('buildHexOfficeLayout is deterministic', () => {
  const a = buildHexOfficeLayout();
  const b = buildHexOfficeLayout();
  assert.deepEqual(a, b);
});

test('the hub and the office do not overlap', () => {
  const layout = buildHexOfficeLayout();
  for (const corner of layout.office.corners) {
    assert.ok(!pointInPolygon(corner, layout.hub.corners), `office corner ${JSON.stringify(corner)} sits inside the hub`);
  }
  for (const corner of layout.hub.corners) {
    assert.ok(!pointInPolygon(corner, layout.office.corners), `hub corner ${JSON.stringify(corner)} sits inside the office`);
  }
});

test('surfaceHeightAt: the hub and office floors are flat at 0', () => {
  const layout = buildHexOfficeLayout();
  assert.equal(hexSurfaceHeightAt(layout, layout.hub.center.x, layout.hub.center.z), 0);
  assert.equal(hexSurfaceHeightAt(layout, layout.office.center.x, layout.office.center.z), 0);
});

test('surfaceHeightAt: climbing the office ramp rises monotonically from 0 to WALKWAY_HEIGHT', () => {
  const layout = buildHexOfficeLayout();
  const { from, to } = layout.officeRamp;
  let previous = -Infinity;
  for (let t = 0; t <= 1.0001; t += 0.1) {
    const x = from.x + (to.x - from.x) * t;
    const z = from.z + (to.z - from.z) * t;
    const height = hexSurfaceHeightAt(layout, x, z);
    assert.notEqual(height, null, `expected a surface at t=${t}`);
    assert.ok(height! >= previous - 1e-9, `height went backwards at t=${t}`);
    previous = height!;
  }
  assert.ok(Math.abs(previous - WALKWAY_HEIGHT) < 1e-6, 'the ramp top reaches walkway height');
});

test('surfaceHeightAt: the deck between the two ramp tops is flat at WALKWAY_HEIGHT', () => {
  const layout = buildHexOfficeLayout();
  const mid = {
    x: (layout.hubRamp.to.x + layout.officeRamp.to.x) / 2,
    z: (layout.hubRamp.to.z + layout.officeRamp.to.z) / 2,
  };
  const height = hexSurfaceHeightAt(layout, mid.x, mid.z);
  assert.ok(height !== null && Math.abs(height - WALKWAY_HEIGHT) < 1e-6);
});

test('surfaceHeightAt: a point far from every surface is null', () => {
  const layout = buildHexOfficeLayout();
  assert.equal(hexSurfaceHeightAt(layout, layout.hub.center.x + 1000, layout.hub.center.z + 1000), null);
});

test('a full walk from the hub floor, up its ramp, across the deck, down the office ramp, onto the office floor never has a null gap', () => {
  const layout = buildHexOfficeLayout();
  const waypoints: Array<[number, number]> = [
    [layout.hub.center.x, layout.hub.center.z],
    [layout.hubRamp.from.x, layout.hubRamp.from.z],
    [layout.hubRamp.to.x, layout.hubRamp.to.z],
    [layout.officeRamp.to.x, layout.officeRamp.to.z],
    [layout.officeRamp.from.x, layout.officeRamp.from.z],
    [layout.office.center.x, layout.office.center.z],
  ];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const [ax, az] = waypoints[i];
    const [bx, bz] = waypoints[i + 1];
    for (let t = 0; t <= 1; t += 0.05) {
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      const height = hexSurfaceHeightAt(layout, x, z);
      assert.notEqual(height, null, `gap in the walk at segment ${i}, t=${t} (${x}, ${z})`);
    }
  }
});

test('wallColliders: the library contributes 5 wall segments, the office 4, the hub 4 (issue #260: the hall connector is a second open edge)', () => {
  const layout = buildHexOfficeLayout();
  const colliders = hexWallColliders(layout);
  // Issue #258: office (4, two open edges: hub and library) + library (5) = 9. Issue #260
  // (step 7a part b): the hub now has two open edges too (the office stair and the hall
  // connector), so it drops from 5 to 4 as well — 9 + 4 = 13.
  assert.equal(colliders.length, 13);
});

test('wallColliders: no wall blocks either ramp\'s own doorway point', () => {
  const layout = buildHexOfficeLayout();
  const colliders = hexWallColliders(layout);
  for (const point of [layout.hubRamp.from, layout.officeRamp.from]) {
    for (const wall of colliders) {
      const inside = point.x > wall.minX && point.x < wall.maxX && point.z > wall.minZ && point.z < wall.maxZ;
      assert.ok(!inside, `a wall blocks the doorway at ${JSON.stringify(point)}`);
    }
  }
});

// --- Issue #261 review: the Hub's own walkway out to the rect hall must never cut through it ---

test('the hall connector\'s walkway never crosses the rect hall\'s own footprint (review-261)', () => {
  const layout = buildHexOfficeLayout();
  const { hubRamp, deck, hallRamp } = layout.hallConnector;
  const insideHall = (p: { x: number; z: number }) =>
    p.x > HALL.minX && p.x < HALL.maxX && p.z > HALL.minZ && p.z < HALL.maxZ;
  const points = [hubRamp.to, ...deck, hallRamp.to];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    for (let t = 0; t <= 1; t += 0.01) {
      const sample = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
      assert.ok(!insideHall(sample), `leg ${i} of the hall connector passes through the hall's own footprint at ${JSON.stringify(sample)}`);
    }
  }
});

// --- Review-261 round 2: the overflow spiral must also steer clear of fixed furniture ---

test('a Hub overflow idle spot never lands close enough to double up on a fixed desk or idle spot, and the cursor never repeats an index (review-261 round 2)', () => {
  const layout = buildHexOfficeLayout();
  const fixed = hubFurnitureSpots(layout.hub);
  const fixedPoints = [...fixed.desks, ...fixed.idle].map((spot) => spot.position);
  const MIN_CLEARANCE = 1.2;
  let cursor = 0;
  const seen = new Set<string>();
  for (let call = 0; call < 60; call++) {
    const { point: spot, nextIndex } = hubOverflowIdleSpot(layout.hub, cursor);
    assert.ok(nextIndex > cursor, `call ${call}: the cursor must always advance, got ${cursor} -> ${nextIndex}`);
    for (const fixedPoint of fixedPoints) {
      const d = Math.hypot(spot.x - fixedPoint.x, spot.z - fixedPoint.z);
      assert.ok(d >= MIN_CLEARANCE, `overflow idle spot (call ${call}) at ${JSON.stringify(spot)} sits only ${d.toFixed(3)} from a fixed Hub spot ${JSON.stringify(fixedPoint)}`);
    }
    const key = `${spot.x.toFixed(3)},${spot.z.toFixed(3)}`;
    assert.ok(!seen.has(key), `call ${call} reused a point a previous call already got: ${key}`);
    seen.add(key);
    cursor = nextIndex;
  }
});

test('a Library overflow research spot never lands close enough to double up on a fixed shelf spot, and the cursor never repeats an index (review-261 round 2)', () => {
  const layout = buildHexOfficeLayout();
  const fixedPoints = [
    { x: layout.library.center.x - 2, z: layout.library.center.z - 2 },
    { x: layout.library.center.x + 2, z: layout.library.center.z + 2 },
  ];
  const MIN_CLEARANCE = 1.2;
  let cursor = 0;
  const seen = new Set<string>();
  for (let call = 0; call < 60; call++) {
    const { point: spot, nextIndex } = libraryOverflowResearchingSpot(layout.library, cursor);
    assert.ok(nextIndex > cursor, `call ${call}: the cursor must always advance, got ${cursor} -> ${nextIndex}`);
    for (const fixedPoint of fixedPoints) {
      const d = Math.hypot(spot.x - fixedPoint.x, spot.z - fixedPoint.z);
      assert.ok(d >= MIN_CLEARANCE, `overflow research spot (call ${call}) at ${JSON.stringify(spot)} sits only ${d.toFixed(3)} from a fixed shelf spot ${JSON.stringify(fixedPoint)}`);
    }
    const key = `${spot.x.toFixed(3)},${spot.z.toFixed(3)}`;
    assert.ok(!seen.has(key), `call ${call} reused a point a previous call already got: ${key}`);
    seen.add(key);
    cursor = nextIndex;
  }
});
