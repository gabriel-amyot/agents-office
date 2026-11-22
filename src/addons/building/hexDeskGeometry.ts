import * as THREE from 'three';
import { FIGURE_EYE_HEIGHT } from '../../characters/StickFigureParts.js';
import { HexFrame } from './HexFrame.js';
import { buildHexOfficeLayout, ROOM_RADIUS, type HexOfficeLayout } from './HexRoomPlanner.js';
import {
  DESK_SEAT_OFFSET,
  DESK_LOOK_OFFSET,
  DESK_LOOK_EYE_HEIGHT,
  DESK_TALK_SPOT_D_OFFSET,
  MONITOR_WIDTH,
  MONITOR_HEIGHT,
  MONITOR_BEZEL_MARGIN,
  MONITOR_A_OFFSET,
  MONITOR_D_OFFSET,
  MONITOR_Y,
  rayBlockedByQuad,
} from './deskGeometry.js';

/**
 * Issue #260 step 7b: the same desk-view geometry `deskGeometry.ts` already gives the rect
 * office (`a`/`d`/`y` offsets off a door-wall frame, a camera pose, two monitors, a queue, a
 * talk spot), ported onto the hex Office's own frame instead. The rect module's numeric
 * constants above (`DESK_SEAT_OFFSET`, `MONITOR_*`, ...) describe the furniture itself — the
 * desk's own depth, a monitor's own size — and carry over unchanged; only the frame and the
 * `a`/`d` placements that depend on available room WIDTH are hex-specific, because unlike a
 * rect room a hex room's width changes with depth (issue #260's own parked plan: narrowest at
 * both openings, widest at the exact midpoint between them).
 *
 * The office is a through-passage (`office.openEdges = [hubSide, librarySide]`, on exactly
 * opposite edges — printed and confirmed on the real `buildHexOfficeLayout()`), not a dead-end
 * room: there is no back wall to put a desk against, so every placement below sits off to one
 * side (negative `a`), leaving the straight line from the Hub door to the Library opening clear
 * down the room's own center.
 */

/** A regular hexagon's own apothem (center to edge-midpoint distance) at `radius` (center to
 * corner) — `radius * sqrt(3) / 2`, the standard relation for a regular hexagon. */
export function hexApothem(radius: number): number {
  return (radius * Math.sqrt(3)) / 2;
}

/** Door-to-door depth of a through-passage hex room: twice the apothem (the straight line
 * between the midpoints of two opposite edges passes through the center). */
export function hexPassageDepth(radius: number): number {
  return 2 * hexApothem(radius);
}

/**
 * The half-width of a through-passage hex room at depth `d` from its near door (0 <= d <=
 * `hexPassageDepth(radius)`): narrowest (half the edge length, which equals `radius` for a
 * regular hexagon) at both doors, widest (`radius`) at the exact midpoint (one apothem in).
 * Linear between those three points, mirrored past the midpoint — the same piecewise shape
 * the step 7b parked plan derived by hand for radius 7, generalized here so a future radius
 * change (or a second office tile) re-derives this instead of re-deriving the formula.
 */
export function hexPassageHalfWidth(radius: number, d: number): number {
  const apothem = hexApothem(radius);
  const depth = 2 * apothem;
  const clamped = Math.max(0, Math.min(depth, d));
  const edgeHalf = radius / 2;
  const nearestDoorDistance = Math.min(clamped, depth - clamped);
  return edgeHalf * (1 + nearestDoorDistance / apothem);
}

/** The office's own hex frame, door at the Hub-facing open edge (`openEdges[0]`, matching
 * `deskGeometry.ts`'s rect convention: `a = 0, d = 0` at the door agents walk in through). */
export function hexOfficeFrame(layout: HexOfficeLayout = buildHexOfficeLayout()): HexFrame {
  return new HexFrame(layout.office, layout.office.openEdges[0]!);
}

/** A margin kept clear of the room's own wall at every depth: furniture, a chair pushed back,
 * or a queued agent's own footprint never reads as clipping into the wall. */
const WALL_MARGIN = 1.0;

function safeHalfWidth(radius: number, d: number): number {
  return hexPassageHalfWidth(radius, d) - WALL_MARGIN;
}

/** Where the desk sits, off to one side (`a < 0`) of the passage's own center line, so the
 * line from the Hub door to the Library opening down the middle (`a = 0`) stays clear the
 * whole way through, per the office's own through-passage shape. */
export const HEX_OFFICE_DESK_D = 4.5;
const HEX_OFFICE_DESK_A = -(safeHalfWidth(ROOM_RADIUS, HEX_OFFICE_DESK_D) - 1.5);

export const HEX_OFFICE_DESK = { a: HEX_OFFICE_DESK_A, d: HEX_OFFICE_DESK_D } as const;

/** The camera's own position and look-at point, with no `fov` attached — split out from
 * `hexDeskCameraPose` purely so `measureRequiredFov` (which derives the FOV constant itself)
 * can compute a pose without reading that constant before it exists. */
function hexDeskCameraPoseRaw(layout: HexOfficeLayout): { position: THREE.Vector3; lookAt: THREE.Vector3 } {
  const frame = hexOfficeFrame(layout);
  const position = frame.point(HEX_OFFICE_DESK.a, HEX_OFFICE_DESK.d + DESK_SEAT_OFFSET, DESK_EYE_HEIGHT_HEX);
  // Issue #260: the desk sits off to one side of the passage (`HEX_OFFICE_DESK.a < 0`), so the
  // door-to-door center line stays clear — but the queue itself is centered on that line
  // (`hexQueueSpotWorldPositions`). Looking straight down the desk's own `a` offset (the rect
  // office's convention, where the desk and the queue share `a = 0`) would point the camera
  // past one whole side of the queue instead of across it, needing an enormous FOV to still
  // catch the far edge (measured: 120+deg) — looking toward the room's own center line (`a =
  // 0`) instead centers the queue in frame and keeps the FOV sane.
  const lookAt = frame.point(0, HEX_OFFICE_DESK.d - DESK_LOOK_OFFSET, DESK_LOOK_EYE_HEIGHT);
  return { position, lookAt };
}

export function hexDeskCameraPose(layout: HexOfficeLayout = buildHexOfficeLayout()): { position: THREE.Vector3; lookAt: THREE.Vector3; fov: number } {
  return { ...hexDeskCameraPoseRaw(layout), fov: HEX_DESK_CAMERA_FOV };
}

/** Same seated-eye-height ratio `deskGeometry.ts` uses (`FIGURE_EYE_HEIGHT * 0.78`), named
 * separately only so this module never has to import the rect `DESK_EYE_HEIGHT` constant by a
 * name that implies a rect-room assumption. */
const DESK_EYE_HEIGHT_HEX = FIGURE_EYE_HEIGHT * 0.78;

const MONITOR_A_OFFSETS = [-MONITOR_A_OFFSET, MONITOR_A_OFFSET] as const;

export function hexMonitorPose(a: number, layout: HexOfficeLayout = buildHexOfficeLayout()): { position: THREE.Vector3; rotationY: number } {
  const frame = hexOfficeFrame(layout);
  const position = frame.point(HEX_OFFICE_DESK.a + a, HEX_OFFICE_DESK.d - MONITOR_D_OFFSET, MONITOR_Y);
  const camera = hexDeskCameraPose(layout).position;
  const rotationY = Math.atan2(camera.x - position.x, camera.z - position.z);
  return { position, rotationY };
}

function quadCorners(position: THREE.Vector3, rotationY: number, width: number, height: number): THREE.Vector3[] {
  const up = new THREE.Vector3(0, 1, 0);
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]) => {
    const local = new THREE.Vector3(sx * (width / 2), sy * (height / 2), 0);
    local.applyAxisAngle(up, rotationY);
    return local.add(position);
  });
}

export function hexMonitorWorldCorners(layout: HexOfficeLayout = buildHexOfficeLayout()): THREE.Vector3[][] {
  return MONITOR_A_OFFSETS.map((a) => {
    const { position, rotationY } = hexMonitorPose(a, layout);
    return quadCorners(position, rotationY, MONITOR_WIDTH + MONITOR_BEZEL_MARGIN * 2, MONITOR_HEIGHT + MONITOR_BEZEL_MARGIN * 2);
  });
}

/**
 * Every queue spot in front of the hex Office's own desk, generated from the room's own
 * width-at-depth (`hexPassageHalfWidth`), not hand-picked: a row of spots at depth `d` fills
 * every `ROW_SPACING`-spaced `a` that stays `WALL_MARGIN` inside the room's own wall AND clear
 * of the desk/chair/monitor cluster (a box around `HEX_OFFICE_DESK`, `a < 0` only). Issue #260's
 * own office-size decision: at least 20 spots, the desk beside the passage (not blocking it).
 */
/** Rows stay well short of the desk camera's own depth (`HEX_OFFICE_DESK.d + DESK_SEAT_OFFSET`,
 * ~6.5): a spot deeper than the camera sits behind it, not in front, and needs an ever-larger
 * FOV to even enter the frustum (found by the first pass of this generator, which let rows run
 * out past the camera and needed a 120+deg FOV to compensate — the fix is fewer, closer rows,
 * not a wider lens). */
const QUEUE_START_D = 1.0;
const ROW_SPACING = 1.0;
const ROW_COUNT = 4;
const SPOT_PITCH = 1.3;
/** The desk/chair/monitor cluster's own footprint, so a queue spot never shares ground with
 * them: every placement above sits at `a <= HEX_OFFICE_DESK.a + 1.5`, `d` in
 * `[HEX_OFFICE_DESK_D - 0.5, HEX_OFFICE_DESK_D + DESK_SEAT_OFFSET + 0.8]`. */
function collidesWithDesk(a: number, d: number): boolean {
  return a <= HEX_OFFICE_DESK.a + 1.5 && d >= HEX_OFFICE_DESK_D - 0.5 && d <= HEX_OFFICE_DESK_D + DESK_SEAT_OFFSET + 0.8;
}

export function hexQueueSpotWorldPositions(layout: HexOfficeLayout = buildHexOfficeLayout()): THREE.Vector3[] {
  const frame = hexOfficeFrame(layout);
  const positions: THREE.Vector3[] = [];
  for (let row = 0; row < ROW_COUNT; row++) {
    const d = QUEUE_START_D + row * ROW_SPACING;
    const half = safeHalfWidth(ROOM_RADIUS, d);
    const offset = row % 2 === 0 ? 0 : SPOT_PITCH / 2;
    for (let a = -half + offset; a <= half; a += SPOT_PITCH) {
      if (collidesWithDesk(a, d)) continue;
      positions.push(frame.point(a, d, FIGURE_EYE_HEIGHT));
    }
  }
  return positions;
}

export function hexDeskTalkSpotPose(layout: HexOfficeLayout = buildHexOfficeLayout()): { position: THREE.Vector3; lookAt: THREE.Vector3 } {
  const frame = hexOfficeFrame(layout);
  const position = frame.point(0, HEX_OFFICE_DESK.d - DESK_TALK_SPOT_D_OFFSET);
  const lookAt = hexDeskCameraPose(layout).position;
  return { position, lookAt };
}

/**
 * The desk-view camera's own vertical FOV, re-derived by measurement (issue #260's own
 * parked plan: "not by reusing 82deg") rather than copied from the rect office. Grown from the
 * rect office's own 60 deg (`SceneSetup.ts` default) one degree at a time until every queue
 * spot clears the frustum at the tightest supported aspect ratio (1.6, `desk-monitors.test.ts`'s
 * own `DESK_VIEW_ASPECTS`), the same empirical method the rect `DESK_CAMERA_FOV`'s own comment
 * describes using originally.
 */
function measureRequiredFov(layout: HexOfficeLayout): number {
  const aspect = 1.6;
  for (let fov = 50; fov <= 120; fov += 1) {
    const { position, lookAt } = hexDeskCameraPoseRaw(layout);
    const camera = new THREE.PerspectiveCamera(fov, aspect, 0.1, 100);
    camera.position.copy(position);
    camera.lookAt(lookAt);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    const spots = hexQueueSpotWorldPositions(layout);
    if (spots.every((spot) => frustum.containsPoint(spot))) return fov;
  }
  return 120;
}

/** Measured once, at module load, against the default layout — a few degrees of margin added
 * on top (the rect `DESK_CAMERA_FOV`'s own comment does the same). */
export const HEX_DESK_CAMERA_FOV = measureRequiredFov(buildHexOfficeLayout()) + 4;

export { rayBlockedByQuad };
