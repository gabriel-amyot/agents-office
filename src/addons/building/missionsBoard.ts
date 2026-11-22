import * as THREE from 'three';
import { canvasBoard } from './missionRooms.js';
import type { HexRoomGeometry } from './HexRoomPlanner.js';

/**
 * The missions board (issue #144): one small wall board near the mission
 * corridor, listing every mission, running or closed, with a timer. Display
 * only, no interaction. Reuses the same canvas-board factory the war rooms'
 * own statement/docs/issues/kanban boards use, so it costs the same one
 * (unmergeable, but already-accounted-for) draw call as any of those.
 *
 * Issue #269 fix: `placeMissionsBoard` used to hang this on the rect building's own hall wall
 * (`mesh.position.set(-5, 1.7, -12.94)`, a hand-measured spot on a wall issue #260 deleted).
 * In the hex layout that coordinate is just empty air between the Hub and its neighbors —
 * exactly the "floating white board in the void" Gabriel flagged live. It now mounts on an
 * actual closed wall segment's midpoint (review round: a corner-interpolation, like the
 * elevator/kitchen placeholders use, lands near a vertex between two walls, not flush against
 * either — 1+ units off the nearest wall by measurement). Edge `+4` off the Hub's first stair
 * is still the preferred slot (clear of the elevator at `+3` and the kitchen at `+2`), but if
 * a later mission wing opens that edge too, this falls back to the next closed one instead of
 * floating in the doorway.
 */

export interface MissionBoardEntry {
  title: string;
  state: 'open' | 'locked';
  /** ISO timestamps. A running mission has `createdAt` only; a closed one has both. */
  createdAt?: string;
  closedAt?: string;
}

/** "2h 15m", "3d 4h", "45m" — coarse enough for a wall board, not a stopwatch. */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

/** One line per mission: its name, state, and the elapsed or final running time. */
export function missionBoardLines(missions: MissionBoardEntry[], now: number): string[] {
  return missions.map((mission) => {
    const created = mission.createdAt ? Date.parse(mission.createdAt) : NaN;
    if (mission.state === 'locked') {
      const closed = mission.closedAt ? Date.parse(mission.closedAt) : NaN;
      const ran = Number.isFinite(created) && Number.isFinite(closed) ? formatDuration(closed - created) : 'unknown';
      return `✓ ${mission.title} — closed, ran ${ran}`;
    }
    const elapsed = Number.isFinite(created) ? formatDuration(now - created) : 'unknown';
    return `○ ${mission.title} — running ${elapsed}`;
  });
}

export function createMissionsBoard(): { mesh: THREE.Mesh; draw: (missions: MissionBoardEntry[], now: number) => void } {
  const board = canvasBoard(2.6, 1.8);
  board.mesh.name = 'missions-board';
  return {
    mesh: board.mesh,
    draw: (missions, now) => {
      board.draw('Missions', missions.length > 0 ? missionBoardLines(missions, now) : ['No missions yet']);
    },
  };
}

/**
 * Mounted on the hall's own north wall, between the two mission-wing doors, facing into the
 * hall — `building-v1` (Rooms v1)'s own rect layout, unchanged, when called with no `hub`.
 *
 * The hex layout (`building/BuildingLayout.ts`) passes its Hub's own geometry instead: that
 * hardcoded rect coordinate is empty air once the hex structure replaces the hall (issue #260
 * deleted it), and this board rendered there as a floating white plate with no wall in sight —
 * exactly the artifact Gabriel flagged live. With `hub` given, it mounts on the Hub's own wall
 * instead, near its back (the elevator sits at `+3`, the kitchen at `+2` off the Hub's first
 * stair; `+4` keeps this board clear of both), facing the Hub center.
 */
export function placeMissionsBoard(mesh: THREE.Mesh, scene: THREE.Scene, hub?: HexRoomGeometry): void {
  const BOARD_HEIGHT = 1.7;
  if (!hub) {
    mesh.position.set(-5, BOARD_HEIGHT, -12.94);
    scene.add(mesh);
    return;
  }
  // Preferred edge first (`+4`, clear of the elevator and kitchen), then the rest of the hex
  // in order, so a closed wall is always found even once other mission wings open more edges.
  const preferredOrder = [4, 5, 3, 2, 1, 0].map((offset) => (hub.openEdges[0]! + offset) % 6);
  const wallEdge = preferredOrder.find((edge) => !hub.openEdges.includes(edge)) ?? preferredOrder[0]!;
  const a = hub.corners[wallEdge]!;
  const b = hub.corners[(wallEdge + 1) % 6]!;
  const wallMid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
  const TOWARD_WALL = 0.85;
  mesh.position.set(
    hub.center.x + (wallMid.x - hub.center.x) * TOWARD_WALL,
    BOARD_HEIGHT,
    hub.center.z + (wallMid.z - hub.center.z) * TOWARD_WALL,
  );
  mesh.lookAt(hub.center.x, BOARD_HEIGHT, hub.center.z);
  scene.add(mesh);
}
