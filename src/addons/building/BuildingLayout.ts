import * as THREE from 'three';
import type { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { Activity } from '../../agents/ActivityAnimations.js';
import type { Station } from '../../scene/Office.js';
import type { LayoutAgent, LayoutMove, LayoutStrategy, RoomView, Seat } from '../../layout/LayoutStrategy.js';
import type { Rect } from './RoomPlanner.js';
import { QUEUE_COUNT_SIGN, station, type WallRect } from './rooms.js';
import { hexDeskCameraPose, hexDeskTalkSpotPose, hexMonitorWorldCorners, hexQueueSpotWorldPositions } from './hexDeskGeometry.js';
import { roomLabel, roomLabelBatchFor } from './roomLabels.js';
import { buildMissionRoom, type MissionRoom } from './missionRooms.js';
import { tombstoneNameBatchFor } from './tombstoneNames.js';
import type { WarRoomCounts } from './warRoomFurnishing.js';
import type { SessionEntry } from './displayWall.js';
import type { WorldRoom } from '../../extensions.js';
import { matchesFloor } from '../../floors/FloorRegistry.js';
import { attentionBand, compareWaits, queuesForYou } from '../../ui/attention.js';
import { markStatic } from '../../scene/StaticMerge.js';
import { createStool } from '../../furniture/Stool.js';
import type { PickTarget } from '../../scene/Selection.js';
import { createMissionsBoard, placeMissionsBoard, type MissionBoardEntry } from './missionsBoard.js';
import { buildHexOffice, hexRoomView, type BuiltHexOffice } from './HexRooms.js';
import { hubOverflowIdleSpot, libraryOverflowResearchingSpot, officeOverflowQueueSpot, pointInPolygon, type ComponentRole, type HexWorldCounts } from './HexRoomPlanner.js';
import { componentForWing } from './componentWing.js';
import { byRecencyNewestFirst } from './missionRecency.js';

/**
 * Work that happens at the agent's own desk. Everything else is a trip. Planning,
 * reviewing and writing docs stay here too: a war-room agent does them at that
 * room's furniture (handled before this check); an agent with no war room has
 * nowhere dedicated for them, so it stays at its desk instead of a trip that
 * would otherwise fall back to the lounge.
 */
const DESK_WORK = new Set<Activity>(['implementing', 'debugging', 'deploying', 'planning', 'reviewing', 'writing_docs']);
/** War-room furniture growth (issue #125): activities that use the room's generic desk-like grid. */
const WAR_ROOM_DESK_LIKE = new Set<Activity>(['implementing', 'reviewing', 'testing', 'writing_docs', 'deploying']);
/**
 * War-room routing (issue #126): an agent's activity maps to a piece in its own war room first.
 * A desk-like activity (not debugging) shares the room's desk grid, same as the growth rule above.
 * Issue #209: no `idle` entry here any more — a war room has no sofa left to send it to; an
 * idle mission agent's `targetFor` below never reaches the room branch at all.
 */
const WAR_ROOM_STATION_FOR: Partial<Record<Activity, string>> = {
  debugging: 'debugging',
  planning: 'planning',
  researching: 'researching',
};
for (const activity of WAR_ROOM_DESK_LIKE) WAR_ROOM_STATION_FOR[activity] = 'implementing';
const TRIP_STATION: Partial<Record<Activity, string>> = {
  researching: 'researching',
  testing: 'testing',
  idle: 'idle',
};
/**
 * The Librarian persona badge (issue #128, Prospero's own review on the issue): the real
 * signal the `bmad` plugin's hat detection reports (`bmad.py agent librarian`, a Skill
 * call, or a subagent type that resolves to it, `plugins/bmad/roster.ts`), never a name
 * or role tag an agent's own session metadata could claim on its own.
 */
function isLibrarian(extras: LayoutAgent['extras']): boolean {
  return Array.isArray(extras?.badges) && extras.badges.includes('librarian');
}

/** A war room's peak desk/debug counts, by room id (issue #129 review round 2): without
 * this, a reload while the room happens to be empty resets its peak to zero in memory,
 * undoing the never-shrinks rule the furniture itself otherwise keeps. Issue #267 review
 * round 1: namespaced under `hex`, never `building` — that prefix is Rooms v1's own live
 * storage now (`building-v1/BuildingLayout.ts`'s own `MISSION_COUNTS_STORAGE_KEY`), restored
 * alongside this layout, not dead data this one owns or may sweep.
 */
export const MISSION_COUNTS_STORAGE_KEY = 'agents-office.hex.missionCounts';
const DEFAULT_DWELL_MS = 4000;
const QUEUE_REFRESH_MS = 500;
const MISSIONS_BOARD_REFRESH_MS = 1000;

/**
 * Lowercased, non-alphanumeric runs collapsed to one `-`, leading/trailing `-` trimmed
 * (issue #89 review, fix 2): `#room=<mission id>` matches a human-typed name against a
 * mission room's own displayed title this way, never against `id` (the server's opaque hash
 * of the mission key; a client never sees the raw slug the server hashed).
 */
function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Issue #260 steps 2+3: BuildingLayout no longer rents rect rooms off the hall — `addRoom`,
 * `saveRooms` and the old `migrateLegacyRooms` are gone, replaced by the hex Hub/Office/
 * Library, which never grow a new rented room. A returning browser may still hold the
 * room-kind lists those deleted functions once saved, under the legacy bare key and its
 * per-floor variants (`building-v1/BuildingLayout.ts`'s own `BUILDING_STORAGE_KEY`/
 * `floorStorageKey`). Issue #267 review round 1: this layout used to sweep that storage once,
 * on the assumption it was dead data left over from a retired feature — Rooms v1's restore
 * proved that assumption wrong (it is that layout's own live room-kind list), so the sweep
 * (`dropLegacyRoomStorage`, `ROOMS_DROPPED_KEY`) is gone. Visiting this layout must never
 * touch a key Rooms v1 owns.
 */

type Target = 'home' | 'pod' | 'queue' | `trip:${string}` | `room:${string}`;

interface AgentState {
  agent: LayoutAgent;
  target: Target | null;
  seat: string | null;
  home: string | null;
  /** The war-room piece type `seat` currently satisfies (`room:<id>:<type>`'s `<type>`), or
   * null for a generic-ring seat, a non-room target, or no seat yet. Lets `seatFor` notice
   * an activity change inside the same room (issue #126 review round 2: the target string
   * alone, `room:<id>`, is the same for every activity in that room, so comparing only that
   * swallowed the change before `claimInRoom` ever ran again). */
  roomStationType: string | null;
  pending: { target: Target; roomStationType: string | null; since: number } | null;
  queuedAt: number | null;
}

export interface BuildingOptions {
  now?: () => number;
  dwellMs?: number;
  /** Only `MISSION_COUNTS_STORAGE_KEY` is read or written through this now (issue #267 review
   * round 1: the legacy room-kind-list sweep that once needed `length`/`key`/`removeItem` too
   * is gone — plain `getItem`/`setItem` is all this layout ever touches). */
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  /** A real wall clock (epoch ms), for the missions board's elapsed/duration timer. Defaults to `Date.now`. */
  wallClock?: () => number;
  /** The focused floor's name (issue #118): meaningful only to `syncWorldRooms`'s own per-floor repo filter now. Unset shows every floor's war rooms (`ALL_FLOORS`). */
  floor?: string;
}

/**
 * The fork's building layout. Each session has a home desk for its life and
 * walks to shared stations for other work. Agents that wait for the user queue
 * in the user's office. Subagents gather at their parent's desk. When a kind of
 * station runs out, the building rents a new room next to the others and never
 * gives it back.
 */
export class BuildingLayout implements LayoutStrategy {
  readonly id = 'building';
  private agents = new Map<string, AgentState>();
  private missionRooms = new Map<string, MissionRoom>();
  /** Issue #259: how many hex rooms each wing (and the Library) has actually claimed so far —
   * `rebuildHexOffice` passes this straight to `buildHexWorld`. The Library stays fixed at 1
   * (its own document-driven growth is a separate, later design, out of this step's scope);
   * the 4 component wings grow one room at a time as `syncWorldRooms` discovers a new mission,
   * `componentForWing` deciding which wing (issue #261 review round 3: a mission's own
   * `component` field first, `componentForRepo` the fallback). */
  private missionWingCounts: HexWorldCounts = { library: 1, portal: 0, agents: 0, tooling: 0, infra: 0 };
  /** Issue #225: whether `syncWorldRooms` has already placed at least one batch of rooms this
   * instance's whole lifetime — `false` only across this `BuildingLayout`'s very first call,
   * the one that corresponds to a fresh page load (a new instance, never reused across a
   * reload). Reorders newest-first only then; every later call (a mission opening while the
   * office is already running) appends in arrival order, no live reflow. */
  private hasSyncedWorldRoomsOnce = false;
  private now: () => number;
  private wallClock: () => number;
  private dwellMs: number;
  private storage: BuildingOptions['storage'];
  private floor: string | undefined;
  private lastQueueRefresh = -Infinity;
  private lastMissionsBoardRefresh = -Infinity;
  private missionBoardEntries: MissionBoardEntry[] = [];
  private missionsBoard = createMissionsBoard();
  /** Issue #218 steps 2/3, grown by #259: the hex Hub, Office, Library and every component
   * wing room — `rebuildHexOffice` tears this down and rebuilds it whenever `missionWingCounts`
   * changes, the same "rebuild the whole merged group" pattern `rebuildHallWalls`/the old
   * `rebuildMissionCorridor` already used for the rect building's own shared zones. */
  private hexOffice!: BuiltHexOffice;
  /** Issue #259 review: the one Library label object, reused across every `rebuildHexOffice`
   * rebuild (see `addHexLibraryStations`'s own comment) rather than leaking a fresh one into
   * `RoomLabelBatch` each time. */
  private hexLibraryLabel: THREE.Object3D | undefined;
  /** Issue #260 step 7b item 4: the hex Office's and Hub's own room labels, same reuse-and-
   * re-parent pattern as `hexLibraryLabel` above — the rect office's own "Your office" plate
   * (`furnishing.ts`'s `usersOffice`) went dark when the rect office was deleted in step 3,
   * and the Hub never had one at all. */
  private hexOfficeLabel: THREE.Object3D | undefined;
  private hexHubLabel: THREE.Object3D | undefined;
  /** Issue #261 review (finding 1): how many overflow idle/research spots have been handed out
   * so far — `claimOfType` grows these one at a time (`hubOverflowIdleSpot`/
   * `libraryOverflowResearchingSpot`), never reusing an already-occupied fixed station. Counts
   * only ever grow, so an index (and so its spot) is never reassigned once an agent holds it. */
  private overflowIdleCount = 0;
  private overflowResearchingCount = 0;
  private overflowQueueCount = 0;

  constructor(private scene: THREE.Scene, private stations: Map<string, Station>, options: BuildingOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.wallClock = options.wallClock ?? (() => Date.now());
    this.dwellMs = options.dwellMs ?? DEFAULT_DWELL_MS;
    this.storage = options.storage;
    this.floor = options.floor;
    this.rebuildHexOffice();
    placeMissionsBoard(this.missionsBoard.mesh, this.scene);
    this.missionsBoard.draw([], this.wallClock());
  }

  /**
   * Issue #259: tears down the current hex structure (if any) and rebuilds it from
   * `missionWingCounts` — the Hub, the Office, the Library behind it, and every component
   * wing's own war rooms so far, as one fresh merged group. Re-adds the Library's own stations
   * and label every time, since they lived on the group this just replaced.
   */
  private rebuildHexOffice(): void {
    if (this.hexOffice) this.scene.remove(this.hexOffice.group);
    this.hexOffice = buildHexOffice(this.missionWingCounts);
    this.scene.add(this.hexOffice.group);
    this.addHexLibraryStations();
    this.addHexHubStations();
    this.addHexOfficeQueueStations();
    this.addHexOfficeAndHubLabels();
  }

  /**
   * Issue #260 step 7b item 4: wayfinding plates for the hex Office ("Your office", the rect
   * office's own old text, now the only office there is) and the hex Hub (a short "Hub" name —
   * the hex structure's own front door, not a named destination the rect building ever had).
   * Same reuse-and-re-parent shape `addHexLibraryStations` already uses for the Library's own
   * plate: both rooms are fixed, single cells that never move, so one label each, built once
   * and just re-parented onto the fresh group every `rebuildHexOffice`, is always still
   * correctly positioned.
   */
  private addHexOfficeAndHubLabels(): void {
    const officeCorners = this.hexOffice.layout.office.corners;
    const officeRect: Rect = {
      minX: Math.min(...officeCorners.map((c) => c.x)),
      maxX: Math.max(...officeCorners.map((c) => c.x)),
      minZ: Math.min(...officeCorners.map((c) => c.z)),
      maxZ: Math.max(...officeCorners.map((c) => c.z)),
    };
    const officeCenter = this.hexOffice.layout.office.center;
    if (!this.hexOfficeLabel) this.hexOfficeLabel = roomLabel('Your office', new THREE.Vector3(officeCenter.x, 0, officeCenter.z), officeRect);
    this.hexOffice.group.add(this.hexOfficeLabel);
    roomLabelBatchFor(this.scene).track(this.hexOfficeLabel);

    const hubCorners = this.hexOffice.layout.hub.corners;
    const hubRect: Rect = {
      minX: Math.min(...hubCorners.map((c) => c.x)),
      maxX: Math.max(...hubCorners.map((c) => c.x)),
      minZ: Math.min(...hubCorners.map((c) => c.z)),
      maxZ: Math.max(...hubCorners.map((c) => c.z)),
    };
    const hubCenter = this.hexOffice.layout.hub.center;
    if (!this.hexHubLabel) this.hexHubLabel = roomLabel('Hub', new THREE.Vector3(hubCenter.x, 0, hubCenter.z), hubRect);
    this.hexOffice.group.add(this.hexHubLabel);
    roomLabelBatchFor(this.scene).track(this.hexHubLabel);
  }

  /**
   * Issue #260 step 7b: the hex Office's own queue, in front of the hex desk
   * (`hexQueueSpotWorldPositions`, 30 spots at `ROOM_RADIUS = 9`) — the replacement for the
   * rect office's rented-room queue (`rooms.ts`'s `office` plan, `type: 'queue'`). Same station
   * type (`'queue'`), so `orderQueue`/`claimOfType('queue')` need no change beyond where the
   * spots come from; `setStationPreservingOccupancy` keeps an already-waiting agent's own seat
   * occupied across a wing-growth rebuild, same as every other hex station here.
   */
  private addHexOfficeQueueStations(): void {
    hexQueueSpotWorldPositions(this.hexOffice.layout).forEach((position, i) => {
      const lookAt = hexDeskCameraPose(this.hexOffice.layout).position;
      this.setStationPreservingOccupancy(`hex-office-queue-${i}`, station('queue', position, lookAt));
    });
  }

  /**
   * Issue #260 (step 7a part a): the Hub's own fixed open-office capacity, the replacement for
   * the old rented `desks`/`lounge` rooms — a spare desk (`implementing`) once the hall's own
   * desks are full, and an idle spot (`idle`) near the kitchen/play corner once the hall's own
   * coffee/sofa spots are full. `HexRooms.ts` already built the desk meshes and the kitchen/
   * play corner's placeholder furniture; this only registers the stations those spots claim,
   * the same split `addHexLibraryStations` already keeps for the Library.
   */
  private addHexHubStations(): void {
    this.hexOffice.hubDeskSpots.forEach((spot, i) => {
      this.setStationPreservingOccupancy(`hex-hub-desk-${i}`, station('implementing', spot.position, spot.lookAt));
    });
    this.hexOffice.hubIdleSpots.forEach((spot, i) => {
      this.setStationPreservingOccupancy(`hex-hub-idle-${i}`, station('idle', spot.position, spot.lookAt));
    });
    // Issue #260 step 7b item 4: the Hub's own fixed test stations — the rect hall's two test
    // stations had no hex home at all; same registration shape as the desk/idle spots above.
    this.hexOffice.hubTestSpots.forEach((spot, i) => {
      this.setStationPreservingOccupancy(`hex-hub-test-${i}`, station('testing', spot.position, spot.lookAt));
    });
  }

  /**
   * Issue #261 review (finding 3): `rebuildHexOffice` reruns `addHexHubStations`/
   * `addHexLibraryStations` from scratch on every wing growth. Setting a brand-new `Station`
   * object at an already-known key reset `occupied` to false every time — an agent still
   * standing there kept its seat visually, but the key itself looked free again, so a second
   * agent arriving right after a wing grew could be handed that exact same key (two agents, one
   * station). Carrying the previous `occupied` flag forward, the same way `updateCounts`'s own
   * war-room rebuild already does for its stations, closes that window.
   */
  private setStationPreservingOccupancy(key: string, next: Station): void {
    const existing = this.stations.get(key);
    this.stations.set(key, existing ? { ...next, occupied: existing.occupied } : next);
  }

  /**
   * Issue #258: the library is a hex room behind the Office now, not a rect room — but
   * research trips and librarians still route by station TYPE (`claimOfType('researching')`),
   * not by which physical room built it (`addRoom`'s own station registration does the same
   * thing for every rect room kind). Two stations, no furniture: `HexRooms.ts` builds the
   * walls/floor/walkway; the library's own shelving and index-wall interior is a separate,
   * larger design (round 7's own open question, not this step's scope).
   */
  private addHexLibraryStations(): void {
    const center = this.hexOffice.layout.library.center;
    const lookAt = new THREE.Vector3(this.hexOffice.layout.office.center.x, 0, this.hexOffice.layout.office.center.z);
    const offsets: Array<[number, number]> = [[-2, -2], [2, 2]];
    for (const [i, [dx, dz]] of offsets.entries()) {
      const position = new THREE.Vector3(center.x + dx, 0, center.z + dz);
      this.setStationPreservingOccupancy(`hex-library-${i}`, station('researching', position, lookAt));
    }
    // Issue #258: the rect library room (and its own label, built by `buildRoom`) is gone;
    // this is the hex Library's own replacement, same text ("Library", `roomTitle`'s own
    // name for the kind), so wayfinding keeps showing a "Library" plate on the new room.
    const corners = this.hexOffice.layout.library.corners;
    const rect: Rect = {
      minX: Math.min(...corners.map((c) => c.x)),
      maxX: Math.max(...corners.map((c) => c.x)),
      minZ: Math.min(...corners.map((c) => c.z)),
      maxZ: Math.max(...corners.map((c) => c.z)),
    };
    // Issue #259 review: `rebuildHexOffice` replaces `this.hexOffice.group` wholesale every
    // time a new mission grows a wing — a fresh `roomLabel()` + `collect()` every single time
    // would leak one stale, now-orphaned label into `RoomLabelBatch` per rebuild (it has no
    // `untrack`, unlike `tombstoneNameBatch`). The Library's own hex cell never moves (its own
    // count is fixed at 1), so one label, reused and just re-parented onto the new group, is
    // always still correctly positioned — `track()` is its own idempotent no-op after the first
    // rebuild.
    if (!this.hexLibraryLabel) this.hexLibraryLabel = roomLabel('Library', new THREE.Vector3(center.x, 0, center.z), rect);
    this.hexOffice.group.add(this.hexLibraryLabel);
    roomLabelBatchFor(this.scene).track(this.hexLibraryLabel);
  }

  /**
   * Rooms from server plugins (mission war rooms). A new room gets the next slot in
   * the mission wing; a known room updates its walls. A locked room keeps standing,
   * and its agents leave.
   */
  syncWorldRooms(worldRooms: WorldRoom[]): LayoutMove[] {
    // Issue #191: a specific floor builds only its own repo's war rooms (`matchesFloor` compares
    // the room's own bare repo tag against this floor's trailing segment, org-qualified or not).
    // Unset `this.floor` is `ALL_FLOORS` (`src/addons/building.ts` never passes a floor option
    // for it), the original behavior: every room shows, repo tag or none.
    const rooms = this.floor === undefined ? worldRooms : worldRooms.filter((room) => matchesFloor(this.floor!, room.repo));
    const newRooms = rooms.filter((room) => !this.missionRooms.has(room.id));
    for (const room of rooms) {
      const known = this.missionRooms.get(room.id);
      if (known) known.update(room);
    }
    if (newRooms.length > 0) {
      // Issue #225 (party round 7, unanimous decision): cells stay fixed and append-only
      // (`claimHexRegion` never moves a claimed cell, `HexRoomPlanner.buildHexWorld`'s own
      // doc comment) — only which mission gets which already-claimed cell is re-sorted, and
      // only on reload (`isReload`: this is the very first `syncWorldRooms` call this
      // `BuildingLayout` instance ever makes, the same "fresh page load" boundary the
      // constructor's own `rebuildHexOffice` call sits on). Sorting each wing's new claims
      // newest-first before tallying ordinals lands the newest mission in the nearest free
      // cell (ring order fills outward in claim order) and an idle one farther out — exactly
      // Gabriel's round-5 ask. A live session's own new mission (`isReload` false here) still
      // just appends outward in arrival order: no live reflow (AC3), an already-placed room
      // never moves mid-session, only the next reload re-sorts again.
      const isReload = !this.hasSyncedWorldRoomsOnce;
      this.hasSyncedWorldRoomsOnce = true;
      const orderedNewRooms = isReload ? [...newRooms].sort(byRecencyNewestFirst) : newRooms;

      // Issue #259: a new mission's wing (`componentForRepo`) grows by exactly one room, in the
      // order its own mission first appears here — the wing's own N-th claimed hex cell, never
      // reassigned once claimed (`HexRoomPlanner.buildHexWorld`'s own append-only guarantee).
      // Every new room's own wing count is tallied first, then the hex structure rebuilds once
      // for the whole batch (never once per room): `rebuildHexOffice` tears down and rebuilds
      // every wing's geometry, so doing that once per new mission in a multi-mission poll would
      // be pure waste.
      const wingOf = new Map<string, ComponentRole>();
      const ordinalOf = new Map<string, number>();
      for (const room of orderedNewRooms) {
        const wing = componentForWing(room);
        wingOf.set(room.id, wing);
        this.missionWingCounts = { ...this.missionWingCounts, [wing]: this.missionWingCounts[wing] + 1 };
        ordinalOf.set(room.id, this.missionWingCounts[wing] - 1);
      }
      this.rebuildHexOffice();
      for (const room of orderedNewRooms) {
        const wing = wingOf.get(room.id)!;
        const hexRoom = this.hexOffice.layout.rooms.filter((candidate) => candidate.role === wing)[ordinalOf.get(room.id)!]!;
        const index = this.missionRooms.size;
        const built = buildMissionRoom(room, index, hexRoom, this.rememberedMissionCounts(room.id));
        this.missionRooms.set(room.id, built);
        this.scene.add(built.group);
        roomLabelBatchFor(this.scene).collect(built.group);
        // Issue #159 review round 1: a room built with sleepers already present (a reload, not a
        // fresh mission) creates its nameplates before `this.scene.add` above; this catches them.
        tombstoneNameBatchFor(this.scene).collect(built.group);
        for (const [key, station] of built.stations) this.stations.set(key, station);
      }
    }
    this.missionBoardEntries = rooms.filter((room) => room.kind === 'mission')
      .map((room) => ({ title: room.title, state: room.state, createdAt: room.createdAt, closedAt: room.closedAt }));
    this.missionsBoard.draw(this.missionBoardEntries, this.wallClock());
    return [];
  }

  get missionRoomCount(): number {
    return this.missionRooms.size;
  }

  /** Every war room's tombstones, pickable by a click or hover (issue #127). */
  tombstonePickTargets(): PickTarget[] {
    return [...this.missionRooms.values()].flatMap((room) => room.tombstonePickTargets());
  }

  /** Every war room's issue board, pickable by a click (issue #146). */
  issuesBoardPickTargets(): PickTarget[] {
    return [...this.missionRooms.values()].map((room) => room.issuesBoardPickTarget());
  }

  /** Every war room's live-sessions board, one pick target per session row shown (issue #223 AC4). */
  sessionsBoardPickTargets(): PickTarget[] {
    return [...this.missionRooms.values()].map((room) => room.sessionsBoardPickTarget());
  }

  /**
   * Where the camera should go to show a named room (issue #89, `#room=`). "office", "library"
   * or "hub" (the hex Hub/Office/Library, `HexRooms.ts`'s own `roomView`), or a mission room.
   * A mission room never matches by a raw `mission:<slug>` key: `id` is the server's opaque
   * hash of that key (`projectWorld`'s `publicId`), so a client never sees the slug it was
   * hashed from (issue #89 review, fix 2). It matches instead by the room's own displayed
   * title, slugified (`#room=media-plan` against the title "Media Plan"), or by the exact
   * public id a reviewer could copy from `/api/world`. Unknown names return null; this never
   * changes the scene, only reports where a camera could go.
   */
  roomView(name: string): RoomView | null {
    const query = name.trim().toLowerCase();
    if (!query) return null;
    // Issue #259: a mission war room is a hex room now — framed the same way `HexRooms.ts`
    // already frames the Hub/Office/Library (`hexRoomView`), not the old rect `roomViewFromSlot`.
    const byId = [...this.missionRooms.values()].find((room) => room.id === name);
    if (byId) return hexRoomView(byId.hexRoom);
    // Two mission rooms can slugify to the same title (issue #89 review, fix round 2): picking
    // the first one silently would show the wrong room. The exact public id always
    // disambiguates them; a title match only resolves when exactly one applies.
    const byTitle = [...this.missionRooms.values()].filter((room) => slugify(room.title) === query);
    if (byTitle.length === 1) return hexRoomView(byTitle[0]!.hexRoom);
    if (byTitle.length > 1) console.debug(`roomView("${name}") matches more than one mission room by title; none resolved`);
    // Issue #218 step 2/3, issue #260 steps 2+3: `#room=hub` / `#room=hex-office` frame the
    // hex rooms; `#room=office` is now a `hex-office` alias (`HexRooms.ts`'s own `roomView`),
    // the rect office it used to frame being gone. Checked last so none of the names above
    // ever resolve differently than before.
    return this.hexOffice.roomView(query);
  }

  /**
   * Where the fixed desk-view camera (issue #161, key `H`) sits: behind the user's own desk,
   * a little lower than a standing first-person pose, looking at the queue in front of it.
   * Issue #260 step 7b: the hex office's own desk (`hexDeskGeometry.ts`), built once at
   * construction and never rented — always present, so this never returns null any more.
   */
  deskView(): { position: THREE.Vector3; lookAt: THREE.Vector3; fov: number } | null {
    return hexDeskCameraPose(this.hexOffice.layout);
  }

  /**
   * Issue #243: the desk-view camera sits essentially where the user's own chair is
   * (`DESK_SEAT_OFFSET`, "inside the chair, not on top of the desk"), close enough and low
   * enough that the hex desk's own FOV (`HEX_DESK_CAMERA_FOV`) always catches the chair's
   * back/seat/pole in its lower half. The chair itself (`Desk.ts`'s `createDesk`, named
   * `'desk-chair'`, `HexRooms.ts`'s `buildHexOfficeDesk`) is hidden instead while in desk mode.
   */
  setDeskChairVisible(visible: boolean): void {
    const chair = this.hexOffice.group.getObjectByName('desk-chair');
    if (chair) chair.visible = visible;
  }

  /**
   * World corners of each desk monitor's bezel, left then right (issue #161 review): lets the
   * label declutter keep a queued agent's label clear of them in desk mode. Delegates to the
   * pure geometry in `hexDeskGeometry.ts` — the one source of where a monitor actually sits, the
   * same one the desk camera pose above and the mesh builder in `deskMonitors.ts` read, so
   * none of the three can drift from the others (review round 2's own root cause).
   */
  deskMonitorCorners(): THREE.Vector3[][] {
    return hexMonitorWorldCorners(this.hexOffice.layout);
  }

  /**
   * Where a selected queued agent walks to address Gabriel directly (issue #162, desk mode
   * only): a fixed spot in front of the desk, standing, facing the desk camera. The hex
   * office's own desk is always present (never rented), so this never returns null any more.
   */
  deskTalkSpot(): Seat | null {
    const pose = hexDeskTalkSpotPose(this.hexOffice.layout);
    return { key: 'desk-talk-spot', position: pose.position, lookAt: pose.lookAt, posture: 'standing' };
  }

  /**
   * Whether this agent currently queues in front of the user's own desk (issue #162): the only
   * agents eligible to walk up to `deskTalkSpot`. A subagent, a war-room agent or anyone else
   * waiting somewhere other than the queue never qualifies, even while selected.
   */
  isQueued(agentId: string): boolean {
    return this.agents.get(agentId)?.target === 'queue';
  }

  /**
   * The room (building or mission) whose floor contains a world point, or null between rooms
   * or outside the building (issue #175, double-click a room in isometric). Issue #260 steps
   * 2+3: every room (Hub, Office, Library and every war room) is a hex polygon now; the old
   * rect-room scan is gone along with `addRoom`.
   */
  roomAt(x: number, z: number): RoomView | null {
    for (const room of this.missionRooms.values()) {
      if (pointInPolygon({ x, z }, room.hexRoom.corners)) return hexRoomView(room.hexRoom);
    }
    return this.hexOffice.roomAt(x, z);
  }

  /**
   * Every wall in the building, as a flat 2D collision list (issue #194). `ViewController`
   * feeds this to `FreeCamera`'s ground-walk every frame. Issue #260 steps 2+3: every war
   * room's walls (and its stair's own open edge) come from the hex structure's own shared
   * `hex-walls` zone, the same as the Hub/Office/Library — `hexWallColliders(layout)` already
   * covers every room in `layout.rooms`, wings included, so there is no rect hall or rented
   * room left to add on top of it.
   */
  wallColliders(): WallRect[] {
    return [...this.hexOffice.wallColliders];
  }

  /**
   * Issue #218 step 3: the walking height at a ground position. The rect building's own
   * floor is always flat (`0`); the hex Hub/Office/walkway/stair (`hexOffice`) is the one
   * part of the building that is not, so it gets first say — `null` there falls through to
   * the rect building's flat floor rather than `FreeCamera`'s own last-known-height fallback.
   */
  surfaceHeightAt(x: number, z: number): number {
    return this.hexOffice.surfaceHeightAt(x, z) ?? 0;
  }

  /** Issue #227: the tool crib's own standing ring, straight from the hex structure. */
  toolCribSpots(): Array<{ position: THREE.Vector3; lookAt: THREE.Vector3 }> {
    return this.hexOffice.cribStandSpots;
  }

  seatFor(agent: LayoutAgent, previous: Activity | null): Seat | null {
    const state = this.stateOf(agent);
    const desired = this.targetFor(state);
    if (previous === null || state.target === null) return this.assign(state, desired);
    // A room target alone (`room:<id>`) is the same string for every activity in that room;
    // an activity change that wants a different piece there (researching -> planning, say)
    // must still re-run `claimInRoom`, not be swallowed by the "same target" no-op below.
    const desiredRoomStationType = desired.startsWith('room:') ? WAR_ROOM_STATION_FOR[state.agent.activity] ?? null : null;
    if (desired === state.target && desiredRoomStationType === state.roomStationType) {
      state.pending = null;
      return null;
    }
    // Waiting for the user is urgent; any other change waits for the dwell time
    if (desired === 'queue') return this.assign(state, desired);
    if (state.pending?.target !== desired || state.pending?.roomStationType !== desiredRoomStationType) {
      state.pending = { target: desired, roomStationType: desiredRoomStationType, since: this.now() };
    }
    return null;
  }

  release(agentId: string): void {
    const state = this.agents.get(agentId);
    if (!state) return;
    this.free(state.seat);
    if (state.home !== state.seat) this.free(state.home);
    this.agents.delete(agentId);
  }

  update(): LayoutMove[] {
    const now = this.now();
    const moves: LayoutMove[] = [];
    for (const state of this.agents.values()) {
      if (!state.pending || now - state.pending.since < this.dwellMs) continue;
      const seat = this.assign(state, state.pending.target);
      if (seat) moves.push({ agentId: state.agent.id, seat });
    }
    if (now - this.lastQueueRefresh >= QUEUE_REFRESH_MS) {
      this.lastQueueRefresh = now;
      moves.push(...this.orderQueue());
    }
    // The missions board's running timer ticks on its own schedule (issue #144), not tied to
    // new mission data (every ~10 s poll): it must visibly move while nothing else changes.
    if (now - this.lastMissionsBoardRefresh >= MISSIONS_BOARD_REFRESH_MS) {
      this.lastMissionsBoardRefresh = now;
      this.missionsBoard.draw(this.missionBoardEntries, this.wallClock());
    }
    this.growMissionFurniture();
    return moves;
  }

  /**
   * War-room furniture grows with the peak concurrent count of desk-like and
   * debugging agents (issue #125, rulebook §3), and never shrinks back; each
   * room tracks its own peak and only rebuilds when a count actually grows.
   */
  private growMissionFurniture(): void {
    if (this.missionRooms.size === 0) return;
    const counts = new Map<string, WarRoomCounts>();
    // Issue #223: the display wall's own live-sessions list, by `agent.extras.room` (the
    // mission a session belongs to) rather than `state.target` (where it is routed right
    // now): an idle session still "works the mission" and should still show on its wall, even
    // though issue #209 sends it to the lounge rather than leaving it seated in the room.
    const sessions = new Map<string, SessionEntry[]>();
    for (const state of this.agents.values()) {
      const roomId = state.target?.startsWith('room:') ? state.target.slice('room:'.length) : null;
      if (roomId && this.missionRooms.has(roomId)) {
        const entry = counts.get(roomId) ?? { deskLike: 0, debugging: 0 };
        if (state.agent.activity === 'debugging') entry.debugging++;
        else if (WAR_ROOM_DESK_LIKE.has(state.agent.activity)) entry.deskLike++;
        counts.set(roomId, entry);
      }
      const missionId = state.agent.extras?.room;
      if (missionId && this.missionRooms.has(missionId)) {
        const list = sessions.get(missionId) ?? [];
        list.push({ id: state.agent.id, name: state.agent.name ?? state.agent.id, extras: state.agent.extras });
        sessions.set(missionId, list);
      }
    }
    for (const [id, room] of this.missionRooms) room.updateSessions(sessions.get(id) ?? []);
    let grew = false;
    for (const [id, room] of this.missionRooms) {
      const before = room.peakCounts;
      const previousKeys = new Set(room.stations.keys());
      room.updateCounts(counts.get(id) ?? { deskLike: 0, debugging: 0 });
      if (room.peakCounts.deskLike !== before.deskLike || room.peakCounts.debugging !== before.debugging) grew = true;
      // `updateCounts` rebuilds the room's own furniture stations (its `stations` map,
      // `missionRooms.ts`); this routing table only ever copied them in once, at the room's
      // first construction (`syncWorldRooms`), before any growth happened — so a grown desk
      // or debug station was never actually reachable (issue #126 review round 2: the very
      // first implementing agent in a fresh war room sat at the generic ring, not a desk).
      // A key still present after a rebuild keeps its own occupied flag, not the freshly
      // built one's false. A key a rebuild dropped (the must-haves' own furniture keys are
      // now keyed by station type and an ordinal within that type, issue #126 review round
      // 3: the desk grid's slots sit first in the plan, so growing one shifts every
      // must-have's array position, but never its type or ordinal) is removed here too, so
      // no stale entry for a piece that no longer exists stays routable.
      for (const key of previousKeys) if (!room.stations.has(key)) this.stations.delete(key);
      for (const [key, station] of room.stations) {
        const existing = this.stations.get(key);
        this.stations.set(key, existing ? { ...station, occupied: existing.occupied } : station);
      }
    }
    // Only on an actual change: a reload while every room happens to be empty must not
    // reset a room's peak to zero (issue #129 review round 2), but writing on every tick
    // regardless would be wasted work.
    if (grew) this.saveMissionCounts();
  }

  // --- Targets ---

  private targetFor(state: AgentState): Target {
    const { agent } = state;
    const parentId = agent.extras?.parentId;
    const cold = attentionBand(agent.extras) === 'cold';
    if (!parentId && (queuesForYou(agent.extras) || (agent.activity === 'meeting' && !cold))) return 'queue';
    const room = agent.extras?.room ? this.missionRooms.get(agent.extras.room) : undefined;
    // Issue #209: an idle mission agent skips its own war room (no sofa there any more) and
    // falls through to the generic `trip:idle` branch below, the main room's lounge/cafeteria.
    if (!parentId && room && !room.locked && agent.activity !== 'idle') return `room:${room.id}`;
    const parent = parentId ? this.agents.get(parentId) : undefined;
    // Only the Librarian persona fetches from the library-knowledge shelves (issue #128):
    // a real persona-hat badge, not a name or role tag (Prospero's own review on the issue).
    // It brings what it found back to its agent otherwise, through the pod branch below.
    if (isLibrarian(agent.extras) && agent.activity === 'researching') return 'trip:researching';
    if (parent && (parent.home || parent.target?.startsWith('room:'))) return 'pod';
    // A non-librarian's research trip never reaches the library-knowledge room either: with
    // a war room it already stayed there (the room check above). Without one it keeps its
    // own desk, the same as desk work (issue #128 AC2) — this covers a subagent whose parent
    // has no seat yet too (the pod check above falls through on that exact timing, issue #128
    // review), not only a main session; the generic trip below is never reached for research.
    if (DESK_WORK.has(agent.activity) || agent.activity === 'researching') return 'home';
    return `trip:${TRIP_STATION[agent.activity] ?? 'idle'}`;
  }

  private assign(state: AgentState, target: Target): Seat {
    if (state.seat && state.seat !== state.home) this.free(state.seat);
    state.pending = null;
    state.queuedAt = target === 'queue' ? (state.queuedAt ?? this.now()) : null;
    state.target = target;

    let key: string;
    if (target === 'home') key = this.homeOf(state);
    else if (target === 'pod') key = this.claim(this.podKeys(this.agents.get(state.agent.extras!.parentId!)!), 'pod');
    else if (target.startsWith('room:')) key = this.claimInRoom(target.slice('room:'.length), state.agent.activity);
    else if (target === 'queue') key = this.claimOfType('queue');
    else key = this.claimOfType(target.slice('trip:'.length));
    state.seat = key;
    // The piece actually claimed, not just the one wanted: `claimInRoom` falls back to the
    // generic ring (or the lounge) when its preferred piece is taken, and that still counts
    // as "no specific piece", not the preferred type, for the next activity-change check.
    const roomMatch = target.startsWith('room:') ? /^room:[^:]+:(.+)$/.exec(this.stations.get(key)!.type) : null;
    state.roomStationType = roomMatch ? roomMatch[1] : null;
    return this.seat(key);
  }

  /**
   * The agent's desk for life, in the shared desk pool (the hall desks, then the hex Hub's
   * own spare desks, issue #260). A session in a herdr workspace prefers a free desk next to
   * one already held by the same workspace. Past that fixed pool (the Hub never grows, round 7:
   * "simplicity and beauty," not an unbounded rented-room chain any more), the same
   * graceful-degradation path `claimOfType` already uses for any other kind of overflow: a spot
   * in the Hub's idle corner, not a crash.
   */
  private homeOf(state: AgentState): string {
    if (state.home) return state.home;
    const workspace = this.workspaceOf(state);
    const free = this.pickDesk(workspace) ?? this.claimOfType('idle');
    this.stations.get(free)!.occupied = true;
    state.home = free;
    return free;
  }

  private workspaceOf(state: AgentState): string | undefined {
    return state.agent.extras?.parentId ? undefined : state.agent.extras?.group?.label;
  }

  /** A free desk next to one already held by the same workspace, else any free desk. */
  private pickDesk(workspace: string | undefined): string | undefined {
    const free = this.keysOfType('implementing').filter((key) => !this.stations.get(key)!.occupied);
    if (free.length === 0) return undefined;
    if (workspace === undefined) return free[0];
    const occupiedByWorkspace = [...this.agents.values()].filter((other) => other.home && this.workspaceOf(other) === workspace).map((other) => other.home!);
    if (occupiedByWorkspace.length === 0) return free[0];
    // "Next to" is physical, not a key suffix: desks stand in rows, so an adjacent
    // suffix can be a row apart while the true nearest desk carries a far suffix.
    const distanceToWorkspace = (key: string): number => {
      const position = this.stations.get(key)!.position;
      return Math.min(...occupiedByWorkspace.map((occupied) => position.distanceTo(this.stations.get(occupied)!.position)));
    };
    return free.reduce((closest, key) => (distanceToWorkspace(key) < distanceToWorkspace(closest) ? key : closest));
  }

  /**
   * A seat in a war room: its own piece for the current activity first (issue #126), so a
   * researching agent stands at that room's bookshelf and a planning agent at its whiteboard,
   * never at the library or a dedicated room. Without a free piece for the activity, or without
   * one at all, the agent takes a free spot in the room's generic ring: a standing spot first
   * (issue #129 AC4, a desk-cap overflow stands, it does not sit at the meeting table), a table
   * seat only once every standing spot is taken too. The table seats and the standing ring
   * share one station type (`room:${roomId}`, `missionRooms.ts`); `posture` is the only thing
   * that tells them apart. Only a room with no free spot of any kind falls back to the lounge.
   */
  private claimInRoom(roomId: string, activity: Activity): string {
    const preferredType = WAR_ROOM_STATION_FOR[activity];
    const preferred = preferredType && this.keysOfType(`room:${roomId}:${preferredType}`).find((key) => !this.stations.get(key)!.occupied);
    if (preferred) return this.claim([preferred], 'room');
    const ring = this.keysOfType(`room:${roomId}`).filter((key) => !this.stations.get(key)!.occupied);
    const free = ring.find((key) => this.stations.get(key)!.posture !== 'seated') ?? ring[0];
    return free ? this.claim([free], 'room') : this.claimOfType('idle');
  }

  /**
   * Spots around the parent's anchor (its war room seat, else its home desk) for
   * its subagents. Each pod gets its own small stool (issue #164): a pod stood by
   * design before, for any activity, which read as "something is wrong" once idle
   * lost its continuous sway (#163) — a standing figure with no activity-driven
   * reason to stand. A stool next to the parent's desk gives every pod subagent a
   * seated posture instead, the same `postureOverride` mechanism the sofa's idle
   * seats already use (`ActivityAnimations.ts`), so a busy or idle pod subagent
   * both read as "has a place," not as a crowd that needs attention.
   *
   * Issue #209 review: `targetFor`'s `pod` decision reads the parent's state at the
   * child's own dwell time, not at assign time; if the parent goes idle (leaving its
   * room, `home` still unset — a mission parent only ever gets a `home` desk through
   * the plain desk-work branch, never through the room branch) in the same tick its
   * child's own pending `pod` assignment matures, `parent.home!` reads `undefined`
   * and this throws. `parent.seat` is always set once a parent has been assigned at
   * all, room or no room, so it is the safe fallback, not a bare `home!`.
   */
  private podKeys(parent: AgentState): string[] {
    const anchorKey = (parent.target?.startsWith('room:') && parent.seat ? parent.seat : parent.home) ?? parent.seat!;
    const desk = this.stations.get(anchorKey)!;
    const facing = new THREE.Vector3().subVectors(desk.lookAt, desk.position).setY(0).normalize();
    const side = new THREE.Vector3(-facing.z, 0, facing.x);
    const keys: string[] = [];
    const offsets: Array<[number, number]> = [[1.0, 0.1], [-1.0, 0.1], [0.55, -0.9], [-0.55, -0.9], [1.4, -0.9], [-1.4, -0.9]];
    offsets.forEach(([across, ahead], i) => {
      const key = `${anchorKey}_pod${i}`;
      if (!this.stations.has(key)) {
        const position = desk.position.clone().addScaledVector(side, across).addScaledVector(facing, ahead);
        const stool = createStool();
        stool.position.copy(position);
        stool.rotation.y = Math.atan2(facing.x, facing.z);
        markStatic(stool, { zone: 'pods' });
        this.scene.add(stool);
        this.stations.set(key, { type: 'pod', position, lookAt: desk.lookAt.clone(), occupied: false, posture: 'seated' });
      }
      keys.push(key);
    });
    return keys;
  }

  // --- Queue ---

  private orderQueue(): LayoutMove[] {
    const waiting = [...this.agents.values()]
      .filter((state) => state.target === 'queue')
      .sort((a, b) => compareWaits(a.agent.extras, b.agent.extras) || (a.queuedAt ?? 0) - (b.queuedAt ?? 0));
    const spots = this.keysOfType('queue');
    // Issue #260 step 7b: the hex office's own ~30 queue spots are fixed (never rented, round
    // 7's own "simplicity and beauty") — past that, a further waiting agent gets its own
    // overflow spiral spot in the office itself, the same pattern the Hub's idle corner and the
    // Library's own shelves already use past their fixed furniture.
    while (spots.length < waiting.length) spots.push(this.allocateOverflowQueueStation());
    // A meeting without a wait also queues, but only fresh and aging waits count for you
    this.showQueueCount(waiting.filter((state) => queuesForYou(state.agent.extras)).length);
    const moves: LayoutMove[] = [];
    for (const state of waiting) this.free(state.seat);
    waiting.forEach((state, i) => {
      const key = spots[i];
      this.stations.get(key)!.occupied = true;
      if (state.seat !== key) {
        state.seat = key;
        moves.push({ agentId: state.agent.id, seat: this.seat(key) });
      }
    });
    return moves;
  }

  /** The sign at the hex office's own desk: "N waiting", hidden when nobody waits. Issue #260
   * step 7b: the hex desk's own queue-count sign (`HexRooms.ts`'s `buildHexOfficeDesk`), not the
   * rect office's. */
  private showQueueCount(count: number): void {
    const sign = this.hexOffice.group.getObjectByName(QUEUE_COUNT_SIGN) as CSS2DObject | undefined;
    if (!sign || sign.userData.queueCount === count) return;
    sign.userData.queueCount = count;
    sign.element.textContent = `${count} waiting`;
    sign.visible = count > 0;
  }

  // --- Stations and rooms ---

  private keysOfType(type: string): string[] {
    return [...this.stations.entries()].filter(([, station]) => station.type === type).map(([key]) => key);
  }

  private claimOfType(type: string): string {
    // Research prefers the Library's own shelves over the two hall shelves. Issue #258: the
    // Library is a hex room now (`hex-library-${i}` stations, `addHexLibraryStations`), not a
    // rect `room${index}_researching_*` one — both name shapes count as "the Library" here.
    const isLibraryKey = (key: string) => key.startsWith('room') || key.startsWith('hex-library');
    const keys = type === 'researching'
      ? [...this.keysOfType(type).filter(isLibraryKey), ...this.keysOfType(type).filter((key) => !isLibraryKey(key))]
      : this.keysOfType(type);
    const free = keys.find((key) => !this.stations.get(key)!.occupied);
    if (free) return this.claim([free], type);
    // Issue #260 step 7b: no more rented 'office'/'desks'/'lab'/'lounge'/'library' rooms — the
    // hex office's own ~30 fixed queue spots, the hex Hub's own fixed capacity (spare desks, the
    // kitchen/play corner) and the hex Library's own two shelves are the first line of overflow
    // past the hall's own stations, and none of them ever grows a new rented room (round 7:
    // "simplicity and beauty"). Review-261 finding 1: past THAT fixed capacity, this used to
    // hand the same already-occupied station to every later agent — real stacking. Every
    // further agent instead gets its own fresh spot, grown on demand from a deterministic,
    // collision-free spiral (never reused, never shared): queueing keeps growing in the office
    // itself, research keeps growing inside the Library itself (finding 2: never the rect room),
    // everything else piles into the Hub's own idle corner, the same terminal case as before.
    if (type === 'queue') return this.claim([this.allocateOverflowQueueStation()], type);
    if (type === 'researching') return this.claim([this.allocateOverflowResearchingStation()], type);
    if (type !== 'idle') return this.claimOfType('idle');
    return this.claim([this.allocateOverflowIdleStation()], 'idle');
  }

  /** Issue #261 review (finding 1): the next overflow idle spot, past the Hub's own fixed desks
   * and idle corner — a fresh station every call, never an existing one. Review round 2:
   * `overflowIdleCount` is now the shared spiral cursor `hubOverflowIdleSpot` hands back, not a
   * plain call count — it can jump by more than 1 when a candidate too close to a fixed Hub
   * spot gets skipped, so the next call never re-reads an index a previous call already tried. */
  private allocateOverflowIdleStation(): string {
    const key = `hex-hub-idle-overflow-${this.overflowIdleCount}`;
    const hub = this.hexOffice.layout.hub;
    const { point: spot, nextIndex } = hubOverflowIdleSpot(hub, this.overflowIdleCount);
    this.overflowIdleCount = nextIndex;
    this.stations.set(key, station('idle', new THREE.Vector3(spot.x, 0, spot.z), new THREE.Vector3(hub.center.x, 1.0, hub.center.z)));
    return key;
  }

  /** Issue #261 review (finding 2): the next overflow research spot, inside the hex Library
   * itself — never the old rect library room `addRoom('library')` used to rent. Review round 2:
   * same shared-cursor contract as `allocateOverflowIdleStation`. */
  private allocateOverflowResearchingStation(): string {
    const key = `hex-library-overflow-${this.overflowResearchingCount}`;
    const library = this.hexOffice.layout.library;
    const office = this.hexOffice.layout.office;
    const { point: spot, nextIndex } = libraryOverflowResearchingSpot(library, this.overflowResearchingCount);
    this.overflowResearchingCount = nextIndex;
    this.stations.set(key, station('researching', new THREE.Vector3(spot.x, 0, spot.z), new THREE.Vector3(office.center.x, 0, office.center.z)));
    return key;
  }

  /** Issue #260 step 7b: the next overflow queue spot, past the hex office's own ~30 fixed
   * queue spots — a fresh station every call, never an existing one. Same shared-cursor
   * contract as `allocateOverflowIdleStation`. */
  private allocateOverflowQueueStation(): string {
    const key = `hex-office-queue-overflow-${this.overflowQueueCount}`;
    const office = this.hexOffice.layout.office;
    const { point: spot, nextIndex } = officeOverflowQueueSpot(office, this.overflowQueueCount);
    this.overflowQueueCount = nextIndex;
    const lookAt = hexDeskCameraPose(this.hexOffice.layout).position;
    this.stations.set(key, station('queue', new THREE.Vector3(spot.x, 0, spot.z), lookAt));
    return key;
  }

  private claim(keys: string[], type: string): string {
    const free = keys.find((key) => !this.stations.get(key)!.occupied);
    if (!free) {
      // More subagents than pod spots: they stand at the next free lounge seat
      return type === 'pod' ? this.claimOfType('idle') : this.claimOfType(type);
    }
    this.stations.get(free)!.occupied = true;
    return free;
  }

  private free(key: string | null): void {
    if (!key) return;
    const station = this.stations.get(key);
    if (station) station.occupied = false;
  }

  private seat(key: string): Seat {
    const station = this.stations.get(key)!;
    return { key, position: station.position, lookAt: station.lookAt, posture: station.posture };
  }

  private stateOf(agent: LayoutAgent): AgentState {
    let state = this.agents.get(agent.id);
    if (!state) {
      state = { agent, target: null, seat: null, home: null, roomStationType: null, pending: null, queuedAt: null };
      this.agents.set(agent.id, state);
    }
    state.agent = agent;
    return state;
  }

  /** A remembered peak for one mission id, read back when that room is (re)built. A
   * malformed or missing entry is treated the same as no history: start at zero. */
  private rememberedMissionCounts(roomId: string): WarRoomCounts | undefined {
    try {
      const parsed: unknown = JSON.parse(this.storage?.getItem(MISSION_COUNTS_STORAGE_KEY) ?? '{}');
      if (typeof parsed !== 'object' || parsed === null) return undefined;
      const entry = (parsed as Record<string, unknown>)[roomId];
      if (typeof entry !== 'object' || entry === null) return undefined;
      const { deskLike, debugging } = entry as Record<string, unknown>;
      if (typeof deskLike !== 'number' || typeof debugging !== 'number') return undefined;
      return { deskLike, debugging };
    } catch {
      return undefined;
    }
  }

  private saveMissionCounts(): void {
    try {
      const byRoomId = Object.fromEntries([...this.missionRooms].map(([id, room]) => [id, room.peakCounts]));
      this.storage?.setItem(MISSION_COUNTS_STORAGE_KEY, JSON.stringify(byRoomId));
    } catch {
      // Storage full or blocked: the building still works for this page
    }
  }
}
