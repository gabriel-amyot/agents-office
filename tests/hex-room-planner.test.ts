import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildHexOfficeLayout,
  cribStandSpots,
  CRIB_STAND_COUNT,
  hexSurfaceHeightAt,
  hexWallColliders,
  hubFurnitureSpots,
  hubOverflowIdleSpot,
  hubToolCribSpot,
  libraryOverflowResearchingSpot,
  pointInPolygon,
  WALKWAY_HEIGHT,
} from '../src/addons/building/HexRoomPlanner.js';
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

test('wallColliders: the library contributes 5 wall segments, the office 4, the hub 5 (issue #260 step 7b item 5: the hall connector, and its hub open edge, is gone)', () => {
  const layout = buildHexOfficeLayout();
  const colliders = hexWallColliders(layout);
  // Issue #258: office (4, two open edges: hub and library) + library (5) = 9. Issue #260 step
  // 7b item 5: the hub is back to a single open edge (the office stair only, the hall connector
  // deleted along with the rect hall it bridged to) — 5 wall segments, same as the library —
  // 9 + 5 = 14.
  assert.equal(colliders.length, 14);
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

// Issue #260 step 7b item 5: the Hub's own walkway out to the rect hall (and the test above
// that proved it never crossed the hall's own footprint, review-261) is gone along with the
// rect hall itself — there is no rect footprint left to bridge to or stay clear of.

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

test('cribStandSpots (issue #227): a fixed ring of CRIB_STAND_COUNT points, each the same distance from the crib counter, no two agents sharing a point', () => {
  const layout = buildHexOfficeLayout();
  const crib = hubToolCribSpot(layout.hub);
  const spots = cribStandSpots(layout.hub);
  assert.equal(spots.length, CRIB_STAND_COUNT);
  const radii = spots.map((spot) => Math.hypot(spot.x - crib.x, spot.z - crib.z));
  for (const radius of radii) assert.ok(Math.abs(radius - radii[0]) < 1e-9, 'every stand spot sits the same distance from the crib');
  const seen = new Set<string>();
  for (const spot of spots) {
    const key = `${spot.x.toFixed(6)},${spot.z.toFixed(6)}`;
    assert.ok(!seen.has(key), `duplicate crib stand spot: ${key}`);
    seen.add(key);
  }
});

test('cribStandSpots is deterministic', () => {
  const layout = buildHexOfficeLayout();
  assert.deepEqual(cribStandSpots(layout.hub), cribStandSpots(layout.hub));
});
