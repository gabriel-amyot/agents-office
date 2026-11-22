import * as THREE from 'three';
import { getToonMaterial } from '../../utils/Materials.js';
import { Colors } from '../../utils/Colors.js';
import type { Station } from '../../scene/Office.js';
import { markStatic } from '../../scene/StaticMerge.js';
import { OFFICE } from '../../utils/Constants.js';
import { DOOR_WIDTH, doorPoint, type Door, type Rect, type Side, wallPieces } from './RoomPlanner.js';
import type { WallRect } from '../../layout/LayoutStrategy.js';
export type { WallRect };

export * from './roomLabels.js';

/** Issue #176: every room's walls are as tall as the main room's (`OFFICE.height`), not their own shorter constant. */
export const WALL_HEIGHT = OFFICE.height;
const WALL_THICKNESS = 0.15;
const DOOR_FRAME_HEIGHT = 2.35;
const DOOR_POST_WIDTH = 0.2;
/** Top of the lintel. */
export const DOOR_FRAME_TOP = DOOR_FRAME_HEIGHT + DOOR_POST_WIDTH;
/** Overview: door frames drop to this height, above the 0.5 walls. */
export const OVERVIEW_DOOR_HEIGHT = 1.2;
const DOOR_FRAME_DEPTH = 0.3;

/**
 * A room's local frame. `d` is the depth from the door wall into the room
 * (0 to ROOM_SIZE), `a` runs along the door wall (-ROOM_SIZE/2 to +ROOM_SIZE/2).
 */
export class RoomFrame {
  readonly inward: THREE.Vector3;
  readonly along: THREE.Vector3;
  private readonly doorWallCenter: THREE.Vector3;

  constructor(readonly rect: Rect, readonly door: Door) {
    const inwardBySide: Record<Side, [number, number]> = { west: [1, 0], east: [-1, 0], north: [0, 1], south: [0, -1] };
    const [nx, nz] = inwardBySide[door.side];
    this.inward = new THREE.Vector3(nx, 0, nz);
    this.along = new THREE.Vector3(-nz, 0, nx);
    const center = new THREE.Vector3((rect.minX + rect.maxX) / 2, 0, (rect.minZ + rect.maxZ) / 2);
    // Issue #123 review (blocking defect 1): the door-to-far-wall depth is the rect's own
    // extent along the inward axis, not always `ROOM_SIZE` — a war room's door on its east or
    // west wall has `WAR_ROOM_WIDTH` of depth in that direction, not the generic room depth.
    const depth = door.side === 'north' || door.side === 'south' ? rect.maxZ - rect.minZ : rect.maxX - rect.minX;
    this.doorWallCenter = center.addScaledVector(this.inward, -depth / 2);
  }

  point(a: number, d: number, y = 0): THREE.Vector3 {
    return this.doorWallCenter.clone().addScaledVector(this.along, a).addScaledVector(this.inward, d).setY(y);
  }

  /** Rotation that makes a piece of furniture face the door (its front looks along -inward). */
  get faceDoor(): number {
    return Math.atan2(-this.inward.x, -this.inward.z);
  }

  /** Rotation that makes a piece of furniture face away from the door. */
  get faceAway(): number {
    return Math.atan2(this.inward.x, this.inward.z);
  }

  /** Where the hall door is along the door wall (`a` of its center). */
  get doorAlong(): number {
    const door = doorPoint(this.rect, this.door, 0);
    return new THREE.Vector3(door.x, 0, door.z).sub(this.doorWallCenter).dot(this.along);
  }
}

export function place(group: THREE.Group, object: THREE.Object3D, position: THREE.Vector3, rotationY: number): void {
  object.position.copy(position);
  object.rotation.y = rotationY;
  group.add(object);
}

export function station(type: string, position: THREE.Vector3, lookAt: THREE.Vector3, posture?: Station['posture']): Station {
  return { type, position, lookAt, occupied: false, ...(posture ? { posture } : {}) };
}

/** Low walls with gaps at the doors, so the overview can see in. */
export function buildWalls(rect: Rect, doors: Door[], height = WALL_HEIGHT, hideSides: Side[] = []): THREE.Group {
  const group = new THREE.Group();
  // Pieces on hidden sides go in one group the overview hides. It merges in place: one draw call, hidden with it
  const hidden = new THREE.Group();
  hidden.name = 'overview-hidden-walls';
  hidden.userData.hiddenFromAbove = true;
  markStatic(hidden);
  const material = getToonMaterial(Colors.wall);
  for (const piece of wallPieces(rect, doors)) {
    const length = piece.to - piece.from;
    if (length < 0.05) continue;
    const horizontal = piece.side === 'north' || piece.side === 'south';
    const geometry = horizontal
      ? new THREE.BoxGeometry(length, height, WALL_THICKNESS)
      : new THREE.BoxGeometry(WALL_THICKNESS, height, length);
    const wall = new THREE.Mesh(geometry, material);
    const middle = (piece.from + piece.to) / 2;
    const fixed = { north: rect.minZ, south: rect.maxZ, west: rect.minX, east: rect.maxX }[piece.side];
    wall.position.set(horizontal ? middle : fixed, height / 2, horizontal ? fixed : middle);
    wall.castShadow = true;
    wall.receiveShadow = true;
    (hideSides.includes(piece.side) ? hidden : group).add(wall);
  }
  if (hidden.children.length > 0) group.add(hidden);
  return group;
}

/**
 * The collision footprints of a room's walls, the same `wallPieces` geometry `buildWalls`
 * draws (doors already left out as gaps), without building any Three.js meshes. `FreeCamera`'s
 * ground-walk collides against the flat list this returns, never the real wall meshes.
 */
export function wallRects(rect: Rect, doors: Door[]): WallRect[] {
  const half = WALL_THICKNESS / 2;
  return wallPieces(rect, doors).map((piece) => {
    const horizontal = piece.side === 'north' || piece.side === 'south';
    const fixed = { north: rect.minZ, south: rect.maxZ, west: rect.minX, east: rect.maxX }[piece.side];
    return horizontal
      ? { minX: piece.from, maxX: piece.to, minZ: fixed - half, maxZ: fixed + half }
      : { minX: fixed - half, maxX: fixed + half, minZ: piece.from, maxZ: piece.to };
  });
}

/** The zone every room's ceiling shares, so they merge into one mesh (review, #184 round 2). */
export const CEILING_ZONE = 'room-ceilings';
/** The merged ceiling zone's own name in the scene (`StaticMerge.ts`'s `static-batch-${zone}`), so `FrameLoop` can find and toggle it without caching a reference that a rebuild could orphan. */
export const CEILING_ZONE_NAME = `static-batch-${CEILING_ZONE}`;

/**
 * A room's ceiling, at the main room's wall height (issue #176: first person gets it back).
 * Merged into the shared `CEILING_ZONE`, the one zone every room's ceiling belongs to (review,
 * #184 round 2): a first attempt toggled each ceiling's own `visible`, which changes a merged
 * source's signature and forces a batch rebuild, ejecting it for one frame on every view
 * switch. Marking each one `dynamic` instead (the round before this one) fixed that, at the
 * cost of a draw call per room, permanently. Merging them all into one zone and toggling the
 * *merged* mesh's own `visible` (`FrameLoop`, by `CEILING_ZONE_NAME`) costs one draw call for
 * every room's ceiling together, with nothing to eject: the zone container is not one of the
 * signature's own sources, so changing its `visible` never triggers a rebuild.
 */
export function buildCeiling(rect: Rect, height: number = WALL_HEIGHT): THREE.Mesh {
  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(rect.maxX - rect.minX, rect.maxZ - rect.minZ),
    getToonMaterial(0xf2ede5),
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set((rect.minX + rect.maxX) / 2, height, (rect.minZ + rect.maxZ) / 2);
  ceiling.receiveShadow = true;
  ceiling.name = 'room-ceiling';
  markStatic(ceiling, { zone: CEILING_ZONE, castShadow: false });
  return ceiling;
}

/** Two posts and a lintel around a doorway, in the room floor color, so doors stand out from the walls. */
export function doorFrame(rect: Rect, door: Door, color: number): THREE.Group {
  const group = new THREE.Group();
  group.name = 'door-frame';
  group.userData.door = { ...door };
  const material = getToonMaterial(color);
  const horizontal = door.side === 'north' || door.side === 'south';
  const wallLine = { north: rect.minZ, south: rect.maxZ, west: rect.minX, east: rect.maxX }[door.side];
  const box = (along: number, across: number, height: number) =>
    (horizontal ? new THREE.BoxGeometry(along, height, across) : new THREE.BoxGeometry(across, height, along));
  const put = (mesh: THREE.Mesh, along: number, y: number) => {
    mesh.position.set(horizontal ? along : wallLine, y, horizontal ? wallLine : along);
    mesh.castShadow = true;
    group.add(mesh);
  };
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(box(DOOR_POST_WIDTH, DOOR_FRAME_DEPTH, DOOR_FRAME_HEIGHT), material);
    post.name = 'door-post';
    put(post, door.at + side * (DOOR_WIDTH / 2 + DOOR_POST_WIDTH / 2 - 0.05), DOOR_FRAME_HEIGHT / 2);
  }
  const lintel = new THREE.Mesh(box(DOOR_WIDTH + DOOR_POST_WIDTH * 2 - 0.1, DOOR_FRAME_DEPTH, DOOR_POST_WIDTH), material);
  lintel.name = 'door-lintel';
  put(lintel, door.at, DOOR_FRAME_HEIGHT + DOOR_POST_WIDTH / 2);
  return group;
}

/** The CSS2D sign under the portrait that counts the queue; `BuildingLayout` sets its text. */
export const QUEUE_COUNT_SIGN = 'queue-count-sign';
