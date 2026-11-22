import * as THREE from 'three';

/**
 * Issue #260 step 7b: the desk/monitor constants that describe the furniture itself (a
 * desk's own seat offset, a monitor's own size), not any one room's shape — split out of
 * the rect-only `deskGeometry.ts` so the hex office (`hexDeskGeometry.ts`) can use them
 * without importing a module that assumes a rect `RoomFrame`/`officeFrame()`. Carries no
 * room-shape assumption itself: only `deskGeometry.ts` (rect) and `hexDeskGeometry.ts`
 * (hex) read the office's own shape to turn these into world positions.
 */

/** How far behind the desk (away from the door) the desk-view camera sits — inside the chair, not on top of the desk. */
export const DESK_SEAT_OFFSET = 2.0;
/** Where the desk-view camera looks: toward the queue in front of the desk, at a standing agent's eye level. */
export const DESK_LOOK_OFFSET = 3.0;
export const DESK_LOOK_EYE_HEIGHT = 1.2;

/** Each monitor's own width and height. */
export const MONITOR_WIDTH = 0.55;
export const MONITOR_HEIGHT = 0.34;
/** The bezel frame sits this much wider than the face on every side. */
export const MONITOR_BEZEL_MARGIN = 0.04;
/** Left and right of the desk's own center, where a monitor sits. */
export const MONITOR_A_OFFSET = 0.62;
/** Close to the desk's own screen position, nearer the camera than the queue. */
export const MONITOR_D_OFFSET = 0.45;
/** Low on the desk, below eye level: the camera reads over the top of them to the queue beyond. */
export const MONITOR_Y = 0.92;

/** How far in front of the desk (toward the queue) the walk-up talk spot sits (issue #162). */
export const DESK_TALK_SPOT_D_OFFSET = 1.0;

/**
 * Does the ray from `origin` to `target` pass through the planar quad `corners` (issue #161
 * review round 2's own sightline check)? Pure geometry, no room-shape assumption: the quad is
 * a flat rectangle (a pure Y-rotation of a plane, always planar); find where the ray meets
 * that plane, then check the hit falls inside the rectangle's own local axes, strictly between
 * the two ends.
 */
export function rayBlockedByQuad(origin: THREE.Vector3, target: THREE.Vector3, corners: THREE.Vector3[]): boolean {
  const [a, b, , d] = corners; // a and d share one edge from a; a and b share the other
  const uAxis = new THREE.Vector3().subVectors(b!, a!);
  const vAxis = new THREE.Vector3().subVectors(d!, a!);
  const normal = new THREE.Vector3().crossVectors(uAxis, vAxis).normalize();
  const direction = new THREE.Vector3().subVectors(target, origin);
  const denom = normal.dot(direction);
  if (Math.abs(denom) < 1e-9) return false; // the ray and the quad's plane never meet
  const t = normal.dot(new THREE.Vector3().subVectors(a!, origin)) / denom;
  if (t <= 1e-6 || t >= 1 - 1e-6) return false; // strictly between the two ends only
  const hit = origin.clone().addScaledVector(direction, t);
  const local = new THREE.Vector3().subVectors(hit, a!);
  const uLenSq = uAxis.lengthSq();
  const vLenSq = vAxis.lengthSq();
  const uProj = local.dot(uAxis) / uLenSq;
  const vProj = local.dot(vAxis) / vLenSq;
  return uProj >= 0 && uProj <= 1 && vProj >= 0 && vProj <= 1;
}
