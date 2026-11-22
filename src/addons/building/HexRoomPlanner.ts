/**
 * Pure geometry for the hex Hub, Office and the walkway/stair between them (issue #218 steps
 * 2 and 3). No Three.js here, same shape as `HexPlanner.ts` and `RoomPlanner.ts`: world-space
 * points and polygons, testable without a scene.
 *
 * Rooms never touch: there is no room-to-room door (the build plan's own rule). Each hex room
 * sits on its own lattice cell, gapped from its neighbors, and is reached only by a stair up
 * to a walkway deck and back down — the "little wire mesh bridge" and "little staircase"
 * Gabriel described in round 7. This file places the first one: Hub to Office.
 */
import {
  claimHexRegion, hexNeighbors, hexPixel, hexKey, ringOf,
  type ComponentRole, type GrowthRequest, type HexCell, type HexPoint, type HexSlot, type RoomRole,
} from './HexPlanner.js';
export type { ComponentRole, RoomRole } from './HexPlanner.js';
import { OFFICE } from '../../utils/Constants.js';
import { HALL } from './RoomPlanner.js';

/** The rect hall's own north wall midpoint (issue #260, step 7a part b): the one side
 * `RoomPlanner.ts`'s `FIRST_RING` never docks a rented room onto (it only ever grows east,
 * south and west) — the hall's one permanently clear wall, so the Hub's own connector never
 * has to fight a rented room for the same opening. */
const HALL_CONNECTOR_DOOR: HexPoint = { x: (HALL.minX + HALL.maxX) / 2, z: HALL.minZ };

/** World offset of the whole hex structure, clear of the existing rect building (whose rooms
 * grow outward from the origin in every direction) so the two coexist without touching, per
 * step 2's AC ("side by side with the old rect rooms, which keep working unconverted"). */
/**
 * Issue #260 (step 7a, "the building should read as one"): the hex structure sits just outside
 * the rect building now, not 360 units away on its own continent. `-x, +z` (south-west of the
 * rect hall) is the one direction clear of every rect-room growth ray: `RoomPlanner.ts`'s
 * `FIRST_RING` only ever rents east (`+x`), south (`+z`, fixed `x` range) and west (`-x`, fixed
 * `z` range) — never north — and the office/library sector (0, angle 0°, `+x`) and `tooling`
 * (sector 3, angle 180°, `-x`) sit on opposite sides of the Hub along the x-axis, so a bare x
 * offset alone still risks a busy `tooling` wing crossing back through x = 0 into the rect
 * building's own spread (issue #259's own review). `-x, +z` together keep the Hub's own center,
 * and so every sector's own growth ray, outside the rect-room footprint at any realistic room
 * count on both sides — re-verified empirically (`tests/mission-wing-overlap.test.ts`'s own
 * stress case), not re-derived by hand. Two tests pull against each other along this exact ray:
 * smaller is always better for the real-size default-isometric label-readability test (every
 * hex floor is now tagged `userData.floor`, part c below, so a closer structure means a tighter
 * default frame and taller label plates), but the overlap check only clears past a magnitude
 * that moves with the lattice's own size.
 *
 * Issue #261 review round 2 (design fidelity, the main point): the first design-fidelity pass
 * (`LATTICE_SPACING` 26 -> 23, a bigger `OFFICE_RADIUS`) still read as one-room-wide chains with
 * long bridges, not a mosaic. Two causes, both now fixed together:
 *
 * 1. Mixed radii cannot share one lattice edge-to-edge, no matter how tight the spacing — every
 *    room (Hub, Office, Library, every war room) is the same `ROOM_RADIUS` now (see below), so
 *    `LATTICE_SPACING` can be derived once, honestly, for true edge-to-edge tangency plus one
 *    short bridge gap.
 * 2. The claim algorithm itself (`HexPlanner.claimHexRegion`) already fills whole rings,
 *    sector by sector, nearest-angle first — a true contiguous wedge, verified directly
 *    (`tests/hex-planner.test.ts`). What read as "chains" in the round-2 screenshot was real
 *    wedges that were too THIN to read as a mass at a realistic room count (2-4 war rooms per
 *    wing only reaches ring 1-2, a handful of tiles) stretched across the old spacing's own long
 *    gaps. Tight, edge-to-edge spacing fixes the read without changing the claim algorithm,
 *    which was already correct.
 *
 * Re-measured the same way as before (a linear scan along this exact direction, smallest
 * magnitude that clears the overlap stress case), with one companion change to the stress case
 * itself: `RENTED_ROOM_COUNT` (see that test's own comment) dropped from 25 to 5 — issue #260
 * retired every rentable room kind except `office`'s own overflow waiting room, so a realistic
 * worst case on the rect side is a small handful of waiting rooms, not the old multi-kind rental
 * free-for-all 25 modeled. Honest, not padded: verified against the real-size fixture, whose own
 * `buildRealSizeOffice()` comment already says the rect building never grows past its one office
 * room at all at today's traffic.
 */
export const HEX_OFFSET: HexPoint = { x: -28.6, z: 49.9 };
/**
 * Every hex room's own floor/wall circumradius — the Hub, the Office, the Library and every war
 * room, all ONE size (issue #261 review round 2: "mixed radii cannot share one lattice edge to
 * edge"). 9 is the review's own suggested value: big enough for the war room's own named base
 * set (desk, debug station, whiteboard, small bookshelf — proven down to 8 by
 * `tests/mission-rooms.test.ts`'s own exhaustive mesh-bounds check, so 9 has headroom, not a
 * squeeze) and the office's own queue (step 7b's own scope to build, not sized to exactly 20
 * here — a uniform lattice is the harder constraint this round; if 7b's own queue math needs
 * more than one uniform tile gives, a multi-tile office cluster, same role repeated over 2-3
 * adjacent cells, is the documented fallback, not a special-cased bigger radius breaking the
 * tangency this constant buys everywhere else).
 */
export const ROOM_RADIUS = 9;
/** How much short bridge gap to leave between two tangent hex rooms (the review's own
 * "about 2" units) — see `LATTICE_SPACING`. */
export const BRIDGE_GAP = 2;
/**
 * The `size` argument `hexPixel`/`worldCenter` scale every cell's own axial coordinate by — NOT
 * the real-world distance between two neighboring cell centers (issue #261 review round 3: the
 * first uniform-radius pass confused the two, leaving gaps about `sqrt(3)` times bigger than
 * intended — roughly 12-13 units instead of 2). `hexPixel`'s own formula
 * (`x = size * sqrt(3) * (q + r/2)`, `z = size * 1.5 * r`) puts every one of the 6 neighbor
 * directions at a real center-to-center distance of `size * sqrt(3)` (checked directly: cell
 * `(1,0)` and cell `(0,1)` both land exactly `size * sqrt(3)` from the origin). True
 * edge-to-edge tangency between two same-size hexes needs that real distance to equal
 * `sqrt(3) * ROOM_RADIUS` (zero gap) plus `BRIDGE_GAP` — so this constant (the `size` argument,
 * not the distance itself) is `ROOM_RADIUS + BRIDGE_GAP / sqrt(3)`, which `* sqrt(3)` back out
 * gives exactly that real distance. */
export const LATTICE_SPACING = ROOM_RADIUS + BRIDGE_GAP / Math.sqrt(3);
/** The Hub's own radius — issue #261 review round 2: no longer a bigger hex (the old `HALL`'s
 * role still, just sized like every other room now, so it tangents its own ring-1 neighbors
 * the same way they tangent each other). */
export const HUB_RADIUS = ROOM_RADIUS;
/** The Office's own circumradius — same uniform size, see `ROOM_RADIUS`'s own comment for why
 * this no longer differs from the Hub or the Library. */
export const OFFICE_RADIUS = ROOM_RADIUS;
/** A component-wing war room's own circumradius — same uniform size. Comfortably above the 8
 * `tests/mission-rooms.test.ts`'s own exhaustive mesh-bounds check proved sufficient for the
 * named base furniture set (issue #259 review round 2's own finding). */
export const WAR_ROOM_HEX_RADIUS = ROOM_RADIUS;

/** Whether a hex room role is one of the 4 component wings (not the hub, office or library). */
export function isComponentRole(role: RoomRole): role is ComponentRole {
  return role !== 'hub' && role !== 'office' && role !== 'library';
}
/** Wall height, shared with the rect building's rooms (`rooms.ts`'s `WALL_HEIGHT`, issue #176:
 * every room is as tall as the main room — `OFFICE.height` directly here, so this stays pure
 * geometry with no Three.js import chain). Hex rooms have no ceiling (round 7 decision), so
 * this is their only height. */
export const HEX_WALL_HEIGHT = OFFICE.height;
/** The walkway deck's height above the floor: wall height plus a small clearance, so it sits
 * visibly above the open-topped rooms. */
export const WALKWAY_HEIGHT = HEX_WALL_HEIGHT + 0.6;
/** "A little bridge... very small": the deck and every ramp share this width. */
export const WALKWAY_WIDTH = 1.6;
export const HEX_WALL_THICKNESS = 0.2;
/** How far a stair ramp runs out from its room's wall before reaching the walkway's height
 * (a V1 approximation of "a little staircase": one straight incline, not discrete steps —
 * the visual detail to refine once the walking flow itself is proven). Issue #261 review round
 * 2: re-derived alongside the uniform `ROOM_RADIUS` and `BRIDGE_GAP` — every room-to-room gap
 * on the lattice is the same `BRIDGE_GAP` (2) now, so `2 * RAMP_LENGTH` must stay within it
 * without the two ramps crossing past the gap's own midpoint. */
export const RAMP_LENGTH = BRIDGE_GAP / 2 - 0.1;
/** A separate, more generous clearance for the one-off Hub-to-hall connector
 * (`hallConnectorFor`): that bridge is not bound by the regular lattice's own tight
 * `BRIDGE_GAP` — it only has to clear the rect hall's own rectangular footprint, where a
 * thin margin risks visually clipping the hall's wall. */
const HALL_CLEARANCE = 3;

function add(a: HexPoint, b: HexPoint): HexPoint {
  return { x: a.x + b.x, z: a.z + b.z };
}

export function sub(a: HexPoint, b: HexPoint): HexPoint {
  return { x: a.x - b.x, z: a.z - b.z };
}

function scale(a: HexPoint, s: number): HexPoint {
  return { x: a.x * s, z: a.z * s };
}

function length(a: HexPoint): number {
  return Math.hypot(a.x, a.z);
}

function normalize(a: HexPoint): HexPoint {
  const len = length(a) || 1;
  return { x: a.x / len, z: a.z / len };
}

/** A hex room's own door-wall frame (issue #258 review: the floor-library plugin's old
 * `shelfPoint`/`doorAlong` assumed a rectangular room with an axis-aligned door wall — a hex
 * room's open edge is rarely axis-aligned). `doorMid` is where the door itself sits (the open
 * edge's own midpoint); `inward` points from there toward the room's center; `along` is
 * `inward` rotated 90°, the room's own "left-right" axis standing at the door looking in. A
 * caller places a shelf/sign/NPC at `doorMid + along * a + inward * d`, the same shape
 * `shelfPoint`'s own `a`/`d` coordinates already had for a rect room, just without that room's
 * own `doorAlong` correction — a hex frame's `doorMid` already IS the door, never off-center. */
export interface HexRoomFrame {
  doorMid: HexPoint;
  inward: HexPoint;
  along: HexPoint;
}

export function hexRoomFrame(room: HexRoomGeometry, openEdgeIndex: number): HexRoomFrame {
  const doorMid = edgeMidpoint(room.center, room.radius, openEdgeIndex);
  const inward = normalize(sub(room.center, doorMid));
  return { doorMid, inward, along: { x: -inward.z, z: inward.x } };
}

/** The 6 corners of a hex room drawn at `radius`, centered at `center`. Independent of
 * `HexPlanner.hexCorners`'s own fixed `HEX_SIZE` — a hex room's drawn size and the lattice
 * spacing between cells are deliberately different numbers (see `ROOM_RADIUS`/`LATTICE_SPACING`
 * above). */
export function hexRoomCorners(center: HexPoint, radius: number): HexPoint[] {
  const corners: HexPoint[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    corners.push({ x: center.x + radius * Math.cos(angle), z: center.z + radius * Math.sin(angle) });
  }
  return corners;
}

/** Ray-casting point-in-polygon, for any simple polygon (a hex room, a ramp or deck quad). */
export function pointInPolygon(point: HexPoint, polygon: HexPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = a.z > point.z !== b.z > point.z;
    if (crosses && point.x < ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** The index (0-5) of the edge of a hex room, at `center`/`radius`, nearest to `toward`: the
 * edge a room opens onto, facing its stair (here: facing the neighbor it connects to). */
export function nearestEdgeIndex(center: HexPoint, radius: number, toward: HexPoint): number {
  const corners = hexRoomCorners(center, radius);
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < 6; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 6];
    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    const dist = length(sub(mid, toward));
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

export function edgeMidpoint(center: HexPoint, radius: number, edgeIndex: number): HexPoint {
  const corners = hexRoomCorners(center, radius);
  const a = corners[edgeIndex];
  const b = corners[(edgeIndex + 1) % 6];
  return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
}

/** The wall segments of a hex room: every edge but the open ones, left clear for a stair.
 * Issue #258 (the library, behind the office): the office now has two stairs — one to the
 * Hub, one to the Library — so a room's open edges are a list, not a single index. */
export function hexWallSegments(center: HexPoint, radius: number, openEdges: number[]): Array<{ a: HexPoint; b: HexPoint }> {
  const corners = hexRoomCorners(center, radius);
  const segments: Array<{ a: HexPoint; b: HexPoint }> = [];
  for (let i = 0; i < 6; i++) {
    if (openEdges.includes(i)) continue;
    segments.push({ a: corners[i], b: corners[(i + 1) % 6] });
  }
  return segments;
}

/** A segment's own AABB, thickened by `half` on every side (issue #194's `WallRect` shape is
 * axis-aligned; a hex wall is usually diagonal, so this is a tight-but-conservative bound
 * around it — the same simplification every other room's wall collision already approximates
 * with a margin, just wider here since the real wall is not axis-aligned). */
export function segmentBounds(a: HexPoint, b: HexPoint, half: number): { minX: number; maxX: number; minZ: number; maxZ: number } {
  return {
    minX: Math.min(a.x, b.x) - half,
    maxX: Math.max(a.x, b.x) + half,
    minZ: Math.min(a.z, b.z) - half,
    maxZ: Math.max(a.z, b.z) + half,
  };
}

/** A quad spanning `a` to `b`, `width` wide (a ramp's or deck's own floor footprint). */
export function quadAlong(a: HexPoint, b: HexPoint, width: number): HexPoint[] {
  const dir = normalize(sub(b, a));
  const perp = { x: -dir.z, z: dir.x };
  const half = scale(perp, width / 2);
  return [add(a, half), add(b, half), sub(b, half), sub(a, half)];
}

/** The height at `point` if it falls on the quad from `a` to `b`, linearly interpolated
 * between `fromHeight` (at `a`) and `toHeight` (at `b`) — a ramp when the two differ, a flat
 * deck when they are equal. `null` off the quad. */
export function segmentHeightAt(point: HexPoint, a: HexPoint, b: HexPoint, width: number, fromHeight: number, toHeight: number): number | null {
  if (!pointInPolygon(point, quadAlong(a, b, width))) return null;
  const dir = sub(b, a);
  const len2 = dir.x * dir.x + dir.z * dir.z || 1;
  const t = Math.max(0, Math.min(1, (sub(point, a).x * dir.x + sub(point, a).z * dir.z) / len2));
  return fromHeight + (toHeight - fromHeight) * t;
}

export interface HexRoomGeometry {
  center: HexPoint;
  radius: number;
  /** Issue #258: the office has two (Hub side, Library side); every other room still has one —
   * except a future branch point (round 7: "wings may branch"), not built yet. */
  openEdges: number[];
  corners: HexPoint[];
  /** Issue #258 steps 5/6: which role this room plays (`hub`/`office`/`library`, or a
   * component wing), and its full planner slot (cell/ring/sector) — a caller that needs to
   * tell rooms apart (`HexRooms.ts`'s per-room marker, a war-room builder) reads this instead
   * of a hardcoded field name. */
  role: RoomRole;
  slot: HexSlot;
}

export interface HexWalkway {
  /** The room's own edge point the ramp starts from, on its floor (y = 0). */
  from: HexPoint;
  /** Where the ramp meets the walkway deck (y = `WALKWAY_HEIGHT`). */
  to: HexPoint;
}

/** One claimed room's own walkway/stair connection to its parent (the already-claimed room one
 * ring closer to the Hub it docks onto) — issue #258 steps 5/6: a wing's rooms chain outward
 * exactly like Hub -> Office -> Library already did, just through an arbitrary tree instead of
 * one fixed 3-room path. */
export interface HexConnection {
  parent: HexRoomGeometry;
  child: HexRoomGeometry;
  /** The parent's own ramp, from its edge facing the child. */
  parentRamp: HexWalkway;
  /** The child's own ramp, from its edge facing the parent. */
  childRamp: HexWalkway;
}

/** Everything the hex office needs to place, build and walk: every claimed room (the Hub,
 * the Office, the Library behind it, and any component wings — issue #258 steps 5/6) and the
 * walkway connecting each one to its own parent. Pure data — `HexRooms.ts` turns it into
 * meshes and colliders. `hub`/`office`/`library` and the four named ramps stay as a
 * convenience (every caller from steps 2-4 already reads them by name); `rooms`/`connections`
 * generalize over however many wing rooms also exist. */
/**
 * The Hub's own short walkway out to the rect building (issue #260, step 7a part b: "one short
 * walkway or open passage from the hall to the hub" — the two structures used to sit 360 units
 * apart with no route between them at all). The same up/flat/down shape every room-to-room
 * `HexConnection` already uses, just with the rect hall's own north wall standing in for a
 * second hex room: `hubRamp` climbs from the Hub's own open edge to `WALKWAY_HEIGHT`, `deck`
 * runs flat (issue #261 review finding: a straight single segment here used to cut straight
 * through the hall's own solid south wall whenever the Hub sits diagonally offset from the
 * door, like it does today — `deck` is a polyline instead, bent to stay outside the hall's own
 * footprint the whole way), `hallRamp` comes back down to the hall's own floor height right at
 * its door.
 */
export interface HallConnector {
  hubRamp: HexWalkway;
  /** Every point of the flat walkway, in order, all at `WALKWAY_HEIGHT`: `deck[0]` is
   * `hubRamp.to`, `deck[deck.length - 1]` is `hallRamp.from`. At least 2 points; more than 2
   * when the straight line between them would cross the hall's own footprint. */
  deck: HexPoint[];
  hallRamp: HexWalkway;
}

export interface HexOfficeLayout {
  rooms: HexRoomGeometry[];
  connections: HexConnection[];
  hub: HexRoomGeometry;
  office: HexRoomGeometry;
  library: HexRoomGeometry;
  hubRamp: HexWalkway;
  officeRamp: HexWalkway;
  /** The office's own stair toward the library (its second open edge). */
  officeLibraryRamp: HexWalkway;
  libraryRamp: HexWalkway;
  hallConnector: HallConnector;
}

/** How many more hex rooms each component wing (and the Library) should grow to, this build —
 * issue #258 steps 5/6: one `GrowthRequest` per unit, same as `library` already was. */
export interface HexWorldCounts {
  library: number;
  portal: number;
  agents: number;
  tooling: number;
  infra: number;
}

function worldCenter(cell: HexCell): HexPoint {
  const p = hexPixel(cell, LATTICE_SPACING);
  return add(p, HEX_OFFSET);
}

/** A room's one stair/ramp toward a neighbor: the open edge facing it, the ramp running
 * outward from that edge toward the walkway. */
function rampToward(center: HexPoint, radius: number, toward: HexPoint): { openEdge: number; ramp: HexWalkway } {
  const openEdge = nearestEdgeIndex(center, radius, toward);
  const edgeMid = edgeMidpoint(center, radius, openEdge);
  const outward = normalize(sub(edgeMid, center));
  return { openEdge, ramp: { from: edgeMid, to: add(edgeMid, scale(outward, RAMP_LENGTH)) } };
}

/**
 * The Hub's own walkway out to the rect hall (issue #260, step 7a part b; re-routed by the
 * issue #261 review). `rampToward` already finds the nearest edge and the first `RAMP_LENGTH`
 * stretch of the climb. Today's `HEX_OFFSET` sits the Hub diagonally offset from the hall
 * (south-west of it), while the door itself (`HALL_CONNECTOR_DOOR`) sits on the hall's own
 * north wall — a single straight deck between those two points necessarily cuts across the
 * hall's own footprint (the review's own finding: through its solid south wall). This instead
 * bends the deck around the hall, staying outside its bounding box the whole way:
 *
 * 1. `hubRamp.to` (already clear of the hall in both axes — the Hub itself sits outside it).
 * 2. Across to `clearX`, a margin outside whichever side of the hall the Hub sits on (its own
 *    `z` unchanged, so this leg never enters the hall's own `z` range either).
 * 3. Up (or down) `clearX` to `clearZ`, a margin beyond the door's own wall, still outside the
 *    hall's `x` range — clear the whole way.
 * 4. Across, still at `clearZ`, to the door's own `x` — still outside the hall's `z` range.
 * 5. `hallRamp`: the final `RAMP_LENGTH` descent straight into the door.
 *
 * Every leg but the last stays strictly outside the hall's rectangle on at least one axis, by
 * construction — not just for today's particular `HEX_OFFSET`.
 */
function hallConnectorFor(hub: HexRoomGeometry): HallConnector {
  const { openEdge, ramp: hubRamp } = rampToward(hub.center, hub.radius, HALL_CONNECTOR_DOOR);
  hub.openEdges.push(openEdge);
  const clearX = hub.center.x <= HALL.minX ? HALL.minX - HALL_CLEARANCE
    : hub.center.x >= HALL.maxX ? HALL.maxX + HALL_CLEARANCE
    : hubRamp.to.x;
  const clearZ = HALL.minZ - HALL_CLEARANCE;
  const bend1: HexPoint = { x: clearX, z: hubRamp.to.z };
  const bend2: HexPoint = { x: clearX, z: clearZ };
  const bend3: HexPoint = { x: HALL_CONNECTOR_DOOR.x, z: clearZ };
  return {
    hubRamp,
    deck: [hubRamp.to, bend1, bend2, bend3],
    hallRamp: { from: bend3, to: HALL_CONNECTOR_DOOR },
  };
}

function requestsFor(counts: HexWorldCounts): GrowthRequest[] {
  const requests: GrowthRequest[] = [];
  const push = (role: 'library' | ComponentRole, count: number) => {
    for (let i = 0; i < count; i++) requests.push({ role });
  };
  push('library', counts.library);
  push('portal', counts.portal);
  push('agents', counts.agents);
  push('tooling', counts.tooling);
  push('infra', counts.infra);
  return requests;
}

/** The already-claimed room one ring closer to the hub that `slot` docks its own walkway onto:
 * among `slot.cell`'s 6 lattice neighbors (`hexNeighbors`), whichever is both one ring closer
 * and already claimed. Deterministic: `hexNeighbors`' own fixed direction order breaks a tie
 * at a sector boundary (rare, only possible where two sectors' own cells happen to share a
 * ring-(r-1) neighbor) the same way every time. The hub itself (ring 0) has no parent. */
function parentOf(slot: HexSlot, bySlotKey: Map<string, HexSlot>): HexSlot | null {
  if (slot.role === 'hub') return null;
  if (slot.ring === 1) return bySlotKey.get(hexKey({ q: 0, r: 0 })) ?? null;
  for (const neighbor of hexNeighbors(slot.cell)) {
    if (ringOf(neighbor) !== slot.ring - 1) continue;
    const candidate = bySlotKey.get(hexKey(neighbor));
    if (candidate) return candidate;
  }
  return null;
}

/** Builds the full hex world from `HexPlanner`'s claim (deterministic, same input every time):
 * every claimed room's own geometry, and a walkway connection from each one to its own parent.
 * Growth only ever appends a cell (`claimHexRegion`'s own doc comment) — raising any one count
 * never moves or reorders a room already placed, the same stability the old rect rented-room
 * system already guaranteed for its own room list. */
export function buildHexWorld(counts: HexWorldCounts): HexOfficeLayout {
  const slots = claimHexRegion(requestsFor(counts));
  const bySlotKey = new Map(slots.map((slot) => [hexKey(slot.cell), slot]));

  const rooms = new Map<string, HexRoomGeometry>();
  for (const slot of slots) {
    const center = worldCenter(slot.cell);
    // Issue #261 review round 2: one uniform radius for every role now (`HUB_RADIUS`,
    // `OFFICE_RADIUS` and `WAR_ROOM_HEX_RADIUS` all equal `ROOM_RADIUS` — see their own
    // comments), the tangency the whole lattice-spacing fix depends on.
    const radius = ROOM_RADIUS;
    rooms.set(hexKey(slot.cell), { center, radius, openEdges: [], corners: hexRoomCorners(center, radius), role: slot.role, slot });
  }

  const connections: HexConnection[] = [];
  for (const slot of slots) {
    const parentSlot = parentOf(slot, bySlotKey);
    if (!parentSlot) continue;
    const room = rooms.get(hexKey(slot.cell))!;
    const parent = rooms.get(hexKey(parentSlot.cell))!;
    const childSide = rampToward(room.center, room.radius, parent.center);
    const parentSide = rampToward(parent.center, parent.radius, room.center);
    room.openEdges.push(childSide.openEdge);
    parent.openEdges.push(parentSide.openEdge);
    connections.push({ parent, child: room, parentRamp: parentSide.ramp, childRamp: childSide.ramp });
  }

  const roomList = [...rooms.values()];
  const byRole = (role: RoomRole) => roomList.find((room) => room.role === role)!;
  const connectionBetween = (parent: HexRoomGeometry, child: HexRoomGeometry) =>
    connections.find((connection) => connection.parent === parent && connection.child === child)!;

  const hub = byRole('hub');
  const office = byRole('office');
  const library = byRole('library');
  const hubOffice = connectionBetween(hub, office);
  const officeLibrary = connectionBetween(office, library);
  const hallConnector = hallConnectorFor(hub);

  return {
    rooms: roomList,
    connections,
    hub, office, library,
    hubRamp: hubOffice.parentRamp,
    officeRamp: hubOffice.childRamp,
    officeLibraryRamp: officeLibrary.parentRamp,
    libraryRamp: officeLibrary.childRamp,
    hallConnector,
  };
}

/** Steps 2-4's own default world: the Hub, the fixed Office, and one Library hex — no
 * component wings. Kept as its own function since every step-4-and-earlier caller and test
 * already calls this with no arguments. */
export function buildHexOfficeLayout(): HexOfficeLayout {
  return buildHexWorld({ library: 1, portal: 0, agents: 0, tooling: 0, infra: 0 });
}

/** The walking height at a world position, across the whole hex structure: any room's floor
 * (0), a stair ramp (0 to `WALKWAY_HEIGHT`), a walkway deck (`WALKWAY_HEIGHT`), or `null`. */
export function hexSurfaceHeightAt(layout: HexOfficeLayout, x: number, z: number): number | null {
  const point = { x, z };
  for (const room of layout.rooms) {
    if (pointInPolygon(point, room.corners)) return 0;
  }
  for (const connection of layout.connections) {
    const onParentRamp = segmentHeightAt(point, connection.parentRamp.from, connection.parentRamp.to, WALKWAY_WIDTH, 0, WALKWAY_HEIGHT);
    if (onParentRamp !== null) return onParentRamp;
    const onChildRamp = segmentHeightAt(point, connection.childRamp.from, connection.childRamp.to, WALKWAY_WIDTH, 0, WALKWAY_HEIGHT);
    if (onChildRamp !== null) return onChildRamp;
    const onDeck = segmentHeightAt(point, connection.parentRamp.to, connection.childRamp.to, WALKWAY_WIDTH, WALKWAY_HEIGHT, WALKWAY_HEIGHT);
    if (onDeck !== null) return onDeck;
  }
  // Issue #260 (step 7a part b): the Hub's own short walkway out to the rect hall — the same
  // up/flat/down shape as a room-to-room connection, just ending at the hall's own door instead
  // of a second hex room.
  const { hubRamp, deck, hallRamp } = layout.hallConnector;
  const onHubRamp = segmentHeightAt(point, hubRamp.from, hubRamp.to, WALKWAY_WIDTH, 0, WALKWAY_HEIGHT);
  if (onHubRamp !== null) return onHubRamp;
  // Issue #261 review: `deck` is a polyline now (it bends around the hall's own footprint
  // instead of cutting straight through it) — every consecutive pair is its own flat segment.
  for (let i = 0; i < deck.length - 1; i++) {
    const onHallDeck = segmentHeightAt(point, deck[i], deck[i + 1], WALKWAY_WIDTH, WALKWAY_HEIGHT, WALKWAY_HEIGHT);
    if (onHallDeck !== null) return onHallDeck;
  }
  const onHallRamp = segmentHeightAt(point, hallRamp.from, hallRamp.to, WALKWAY_WIDTH, WALKWAY_HEIGHT, 0);
  if (onHallRamp !== null) return onHallRamp;
  return null;
}

/** Every hex wall segment's collision footprint, for `LayoutStrategy.wallColliders()`. */
export function hexWallColliders(layout: HexOfficeLayout): Array<{ minX: number; maxX: number; minZ: number; maxZ: number }> {
  const half = HEX_WALL_THICKNESS / 2;
  return layout.rooms.flatMap((room) => hexWallSegments(room.center, room.radius, room.openEdges).map((segment) => segmentBounds(segment.a, segment.b, half)));
}

/** Halfway between the Hub's own center and one of its 6 corners, offset from its first open
 * edge (the elevator/kitchen placement's own pattern, `HexRooms.ts`'s `buildHexOffice`). */
function hubCornerAnchor(hub: HexRoomGeometry, cornerOffset: number): HexPoint {
  const corner = hub.corners[(hub.openEdges[0]! + cornerOffset) % 6];
  return { x: (hub.center.x + corner.x) / 2, z: (hub.center.z + corner.z) / 2 };
}

export interface HubFurnitureSpot {
  position: HexPoint;
  /** Faces this point (the Hub's own center, so a desk or idle spot always looks inward). */
  lookAt: HexPoint;
}

/** The angle between successive points of a sunflower/phyllotaxis spiral — the standard
 * constant that keeps the spiral's own points roughly evenly spaced at every radius, so no
 * two indices ever drift close together the way a round-number angle step eventually would. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Review-261 (finding 1): past `hubFurnitureSpots`'/the hex Library's own FIXED station count,
 * `BuildingLayout.claimOfType('idle' | 'researching')` used to hand out the same already-
 * occupied spot to every later agent — real stacking, not a cosmetic bug. This is the
 * replacement: a deterministic, collision-free spot for any index, grown outward from `center`
 * one at a time, never reused. A golden-angle spiral (`radius = packing * sqrt(index + 1)`,
 * `angle = index * GOLDEN_ANGLE`) is the standard way to pack an unbounded number of points with
 * no two ever closer than roughly `packing` apart, by construction — no index ever needs to
 * collide-check against any other.
 *
 * Capped at `maxRadius` (a wall clearance short of the room's own drawn radius, so every spot
 * stays inside the room's own floor and wall-collision footprint); past that cap (a generous
 * margin past any real headcount — see call sites) the spiral wraps to a fresh lap at a shifted
 * starting angle, so even an unrealistic flood of agents never lands two of them on the exact
 * same point, just a tighter and tighter pack within the same floor.
 *
 * Review-261 round 2 (the review's own follow-up): the spiral alone only keeps its OWN points
 * apart from each other — nothing stopped a spiral point from landing on top of a fixed station
 * (a Hub desk, a Library shelf) that is not part of the spiral at all. `avoid` is the fixed
 * spots to steer clear of; a candidate within `minClearance` of any of them is skipped and the
 * next spiral index tried instead.
 *
 * Skipping an index must never let two DIFFERENT calls land on the same skipped-to point — if
 * each call independently restarted its own skip-scan from its own `index`, two calls whose
 * `index` both get skipped past the same obstacle could converge on the same candidate (a real
 * regression the round-2 review caught via its own 60-agent test). The fix: every call reports
 * `nextIndex`, the first internal candidate it did NOT consume, and the caller passes that back
 * in as the next call's own `index` — a single shared cursor, so the set of internal candidates
 * actually handed out is always a prefix-free, strictly increasing sequence; no two calls ever
 * read the same one.
 */
function overflowSpiralPoint(center: HexPoint, index: number, packing: number, maxRadius: number, avoid: HexPoint[] = [], minClearance = 1.2): { point: HexPoint; nextIndex: number } {
  const perLap = Math.max(1, Math.floor((maxRadius / packing) ** 2));
  const pointAt = (candidateIndex: number): HexPoint => {
    const lap = Math.floor(candidateIndex / perLap);
    const i = candidateIndex % perLap;
    const radius = Math.min(maxRadius, packing * Math.sqrt(i + 1));
    const angle = i * GOLDEN_ANGLE + lap * (GOLDEN_ANGLE / 2);
    return { x: center.x + radius * Math.cos(angle), z: center.z + radius * Math.sin(angle) };
  };
  for (let candidateIndex = index; candidateIndex < index + 500; candidateIndex++) {
    const point = pointAt(candidateIndex);
    if (avoid.every((spot) => Math.hypot(spot.x - point.x, spot.z - point.z) >= minClearance)) {
      return { point, nextIndex: candidateIndex + 1 };
    }
  }
  // Every one of 500 candidates landed too close to a fixed spot: hand out the last one tried
  // anyway (a crowded floor should still seat every agent, just tighter) rather than throw.
  return { point: pointAt(index + 500), nextIndex: index + 501 };
}

/** A clearance short of `HUB_RADIUS` so an overflow idle spot never stands inside the Hub's
 * own wall. `0.85` packing: close enough together to read as a crowd, far enough that two
 * stick figures never visually overlap (`tests/`'s own personal-space margin elsewhere). */
const HUB_OVERFLOW_PACKING = 0.85;
const HUB_OVERFLOW_MAX_RADIUS = HUB_RADIUS - 1.5;

/** The `index`-th overflow idle spot (issue #261): past the Hub's own fixed desks and idle
 * corner, every further idle/overflow agent gets one of these instead of sharing a spot.
 * Review-261 round 2: also steers clear of the Hub's own fixed desk and idle positions
 * (`hubFurnitureSpots`), so an overflow spot never lands close enough to double up on an
 * already-furnished, already-occupied seat. The caller passes the cursor it got back from its
 * own previous call (0 for the first one) as `index`, and must store `nextIndex` for the next
 * call — never call this twice with the same `index`. */
export function hubOverflowIdleSpot(hub: HexRoomGeometry, index: number): { point: HexPoint; nextIndex: number } {
  const fixed = hubFurnitureSpots(hub);
  const avoid = [...fixed.desks, ...fixed.idle].map((spot) => spot.position);
  return overflowSpiralPoint(hub.center, index, HUB_OVERFLOW_PACKING, HUB_OVERFLOW_MAX_RADIUS, avoid);
}

const LIBRARY_OVERFLOW_PACKING = 0.85;
const LIBRARY_OVERFLOW_MAX_RADIUS = ROOM_RADIUS - 1.5;
/** The hex Library's own 2 fixed shelf offsets from its center (`BuildingLayout`'s
 * `addHexLibraryStations`, `[-2,-2]`/`[2,2]`) — kept here too so the overflow spiral can steer
 * clear of them without `HexRoomPlanner.ts` importing `BuildingLayout.ts`. */
const LIBRARY_SHELF_OFFSETS: Array<[number, number]> = [[-2, -2], [2, 2]];

/** The `index`-th overflow research spot (issue #261 review): past the hex Library's own two
 * shelves and the hall's own two, a librarian researching still gets its own spot in the
 * Library itself — never the old rect library room (review-261 finding 2: that path must never
 * build again). Review-261 round 2: also steers clear of the Library's own 2 fixed shelf spots.
 * Same cursor contract as `hubOverflowIdleSpot`. */
export function libraryOverflowResearchingSpot(library: HexRoomGeometry, index: number): { point: HexPoint; nextIndex: number } {
  const avoid = LIBRARY_SHELF_OFFSETS.map(([dx, dz]) => ({ x: library.center.x + dx, z: library.center.z + dz }));
  return overflowSpiralPoint(library.center, index, LIBRARY_OVERFLOW_PACKING, LIBRARY_OVERFLOW_MAX_RADIUS, avoid);
}

/**
 * The Hub's own fixed furniture layout (issue #260, step 7a part a: overflow past the hall's
 * own desks/test stations/idle corner goes here instead of a rented room). The Hub never grows
 * (round 7: "simplicity and beauty," a fixed open office), so this is a fixed count, not a plan
 * that scales with agent count the way a war room's furniture does.
 *
 * Desks cluster at the two corners `buildHexOffice`'s own elevator (`+3`) and kitchen (`+2`)
 * placements leave free (`+1` and `+4` from the Hub's first open edge, offset from `+2`/`+3` the
 * same half-way-to-corner distance); idle spots ring the kitchen/play corner itself (`+2`), the
 * "kitchen and play area where idle agents relax" round 7 asked for — no extra furniture mesh,
 * just somewhere to stand near it.
 */
export function hubFurnitureSpots(hub: HexRoomGeometry): { desks: HubFurnitureSpot[]; idle: HubFurnitureSpot[] } {
  const center = hub.center;
  const desks: HubFurnitureSpot[] = [];
  for (const cornerOffset of [1, 4]) {
    const anchor = hubCornerAnchor(hub, cornerOffset);
    const along = normalize({ x: -(anchor.z - center.z), z: anchor.x - center.x });
    for (const spread of [-1.6, -0.5, 0.6, 1.7]) {
      desks.push({
        position: { x: anchor.x + along.x * spread, z: anchor.z + along.z * spread },
        lookAt: center,
      });
    }
  }
  const kitchen = hubCornerAnchor(hub, 2);
  const along = normalize({ x: -(kitchen.z - center.z), z: kitchen.x - center.x });
  const idle: HubFurnitureSpot[] = [-1.4, -0.7, 0.7, 1.4].map((spread) => ({
    position: { x: kitchen.x + along.x * spread + (center.x - kitchen.x) * 0.25, z: kitchen.z + along.z * spread + (center.z - kitchen.z) * 0.25 },
    lookAt: center,
  }));
  return { desks, idle };
}
