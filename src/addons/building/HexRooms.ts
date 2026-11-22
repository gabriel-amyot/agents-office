/**
 * Three.js geometry for the hex Hub and Office (issue #218 steps 2 and 3): the first real
 * hex rooms, built side by side with the old rect rooms (`BuildingLayout`'s own `HALL` and
 * `slotFor` rooms), which keep working unconverted. Everything here reads `HexRoomPlanner.ts`
 * for positions — this module only turns that pure geometry into meshes, materials and
 * colliders.
 *
 * Draw-call budget (issue #218 step 1's own render-budget note: main sat at 424/430 before
 * this PR, only 6 calls of headroom): every hex wall shares one material, both hex floors
 * share one (review: a two-tone split was purely cosmetic and not worth a 5th call), the
 * walkway deck and both ramps share one, and the Hub's placeholder furniture (elevator,
 * kitchen, play corner) shares one more — 4 new draw calls total, regardless of room or
 * furniture count, the same `markStatic` merge story every other room in this fork already
 * uses. None of this new geometry casts a shadow (`castShadow: false` throughout): the
 * structure sits far from the main building and its own lights, and 6 calls of headroom has
 * no room for shadow-map passes on top of the main-pass cost. New pin: 428/430 — see the
 * budget rule in issue #217: every later step that adds hex geometry pays for itself by
 * deleting the rect-building code it replaces in the same PR (step 4 deletes the rect
 * library's room path, step 5 deletes the mission corridor), so this budget never needs a cap
 * raise before step 7 deletes the legacy rect system outright. Real, per-piece furniture (the
 * office desk, the queue station, the Hub's leftover desks) is explicitly deferred to the
 * plan's own step 7 ("ship the open-office leftover-desk furnishing"); this PR's AC only
 * needs the Hub reachable with an elevator and kitchen object present, not the full
 * furnishing pass.
 */
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { getToonMaterial } from '../../utils/Materials.js';
import { markStatic } from '../../scene/StaticMerge.js';
import type { WallRect } from '../../layout/LayoutStrategy.js';
import {
  buildHexOfficeLayout,
  buildHexWorld,
  hexWallSegments,
  hexWallColliders,
  hexSurfaceHeightAt,
  hexRoomFrame,
  hubFurnitureSpots,
  hubToolCribSpot,
  pointInPolygon,
  type HexOfficeLayout,
  type HexRoomGeometry,
  type HexWorldCounts,
  HEX_WALL_HEIGHT,
  HEX_WALL_THICKNESS,
  WALKWAY_HEIGHT,
  WALKWAY_WIDTH,
} from './HexRoomPlanner.js';
import type { HexPoint } from './HexPlanner.js';
import { FIGURE_EYE_HEIGHT } from '../../characters/StickFigureParts.js';
import { createDesk } from '../../furniture/Desk.js';
import { createTestStation } from '../../furniture/TestStation.js';
import { createToolCrib } from '../../furniture/ToolCrib.js';
import { hexOfficeFrame, HEX_OFFICE_DESK } from './hexDeskGeometry.js';
import { QUEUE_COUNT_SIGN } from './rooms.js';

/** A stone tone distinct from the rect building's own `Colors.wall`, so the two structures
 * read as separate at a glance in the isometric view. */
const HEX_WALL_COLOR = 0xcbbfa6;
/** One shared floor tone for the Hub and Office (review: a two-tone split cost a 5th draw
 * call for a purely cosmetic distinction — not worth it against a 1-point budget margin). */
const HEX_FLOOR_COLOR = 0x6f6456;
/** The walkway deck and both ramps: a cooler, metal-grate tone (the "wire mesh bridge"). */
const WALKWAY_COLOR = 0x5a6670;
/** The Hub's placeholder furniture (elevator, kitchen counter, play corner): one shared
 * accent material, so any number of these pieces still costs one draw call. */
const HEX_ACCENT_COLOR = 0x33363d;

const WALKWAY_DECK_THICKNESS = 0.15;

function v3(point: HexPoint, y: number): THREE.Vector3 {
  return new THREE.Vector3(point.x, y, point.z);
}

/** A box between two points, its local X axis stretched to the distance and turned to face
 * `from -> to` (a horizontal wall segment, or a tilted ramp when the two differ in height).
 * No shadow cast (issue #218 step 1's render-budget note): the structure sits far from the
 * main building and its own lights, so a cast shadow here buys little for 3 shadow-map
 * passes' worth of cost; every mesh still receives, for grounding. Revisit once more of the
 * hex office exists and the render-budget headroom can be rebalanced. */
function orientedBox(from: THREE.Vector3, to: THREE.Vector3, crossA: number, crossB: number, material: THREE.Material): THREE.Mesh {
  const direction = new THREE.Vector3().subVectors(to, from);
  const length = direction.length();
  const geometry = new THREE.BoxGeometry(Math.max(length, 0.01), crossA, crossB);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(from).addScaledVector(direction, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), direction.clone().normalize());
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  return mesh;
}

/** A hex room's floor: a flat polygon fan from its center. Tagged `userData.floor` (issue
 * #260, step 7a part c): that tag feeds `overviewBounds`'s `floorBounds`, which unions every
 * floor's world bounds into the isometric camera's default pan/zoom limits. Step 2 deliberately
 * left this untagged while `HEX_OFFSET` sat 360 units from the rect building — it zoomed the
 * default view out far enough to drop "Your office"'s label under the 22 px readability floor
 * (`tests/wayfinding.test.ts`). Issue #260 step 7b item 5: the rect hall is gone from the
 * 'building' layout entirely now, and `HEX_OFFSET` centers the hex building at the origin — the
 * default isometric overview frames the whole hex building alone (Hub, Office, Library, every
 * wing), nothing else left to show; the real-size label-readability test is what actually
 * proves the margin still holds. */
function buildHexFloor(room: HexRoomGeometry, color: number): THREE.Mesh {
  const positions: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = room.corners[i];
    const b = room.corners[(i + 1) % 6];
    // Review (#242): center -> b -> a, not center -> a -> b. `corners` is ordered by
    // increasing angle, which winds a center -> a -> b fan clockwise seen from above (+Y) —
    // its face normal points down, invisible to `FrontSide` `getToonMaterial()` from a
    // downward view or raycast. Swapping a/b flips the winding to counter-clockwise from
    // above, normal up, matching every rect room's floor.
    positions.push(room.center.x, 0, room.center.z, b.x, 0, b.z, a.x, 0, a.z);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, getToonMaterial(color));
  mesh.name = 'hex-floor';
  mesh.receiveShadow = true;
  mesh.userData.floor = true;
  return mesh;
}

/** The wall segments of a hex room (its stairs' own edges left open — the office has two,
 * everything else has one), one mesh per segment, all sharing the same material so they
 * merge into the room's shared wall batch. */
function buildHexWalls(room: HexRoomGeometry, material: THREE.Material): THREE.Mesh[] {
  return hexWallSegments(room.center, room.radius, room.openEdges).map((segment) =>
    orientedBox(v3(segment.a, HEX_WALL_HEIGHT / 2), v3(segment.b, HEX_WALL_HEIGHT / 2), HEX_WALL_HEIGHT, HEX_WALL_THICKNESS, material),
  );
}

/** A placeholder elevator: a tall frame with two inset "doors" — enough to read as an
 * elevator at a glance (AC: "elevator ... objects are present"), one shared material so it
 * costs nothing beyond the Hub's own accent draw call. */
function buildElevator(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'hex-hub-elevator';
  const material = getToonMaterial(HEX_ACCENT_COLOR);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(2.4, HEX_WALL_HEIGHT * 0.85, 0.3), material);
  frame.position.y = (HEX_WALL_HEIGHT * 0.85) / 2;
  frame.castShadow = false;
  frame.receiveShadow = true;
  group.add(frame);
  for (const x of [-0.55, 0.55]) {
    const door = new THREE.Mesh(new THREE.BoxGeometry(1, HEX_WALL_HEIGHT * 0.78, 0.08), material);
    door.position.set(x, (HEX_WALL_HEIGHT * 0.78) / 2, 0.19);
    door.castShadow = false;
    door.receiveShadow = true;
    group.add(door);
  }
  return group;
}

/** A placeholder kitchen/play corner: a counter and a low table, one shared material —
 * enough to read as "kitchen and play area" (AC: "kitchen ... objects are present"). Real
 * furniture (the existing `Kitchen.ts`/`FoosballTable.ts` factories) is deferred: each one
 * brings its own extra colors, which this PR's tight draw-call headroom (~6 of 430) does not
 * have room for yet — a follow-up visual pass once the walking flow is proven.
 */
function buildKitchenCorner(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'hex-hub-kitchen';
  const material = getToonMaterial(HEX_ACCENT_COLOR);
  const counter = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.9, 0.6), material);
  counter.position.y = 0.45;
  counter.castShadow = false;
  counter.receiveShadow = true;
  group.add(counter);
  const playTable = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.8, 0.9), material);
  playTable.position.y = 0.4;
  playTable.castShadow = false;
  playTable.receiveShadow = true;
  group.add(playTable);
  return group;
}

/**
 * Where the camera should go to show a hex room (issue #242 review: `#room=hub` /
 * `#room=hex-office`, the same `RoomView` shape `BuildingLayout.roomView` already returns for
 * a rect room). `hex-office`, not `office` (that name is already the rect office's own, and
 * both rooms exist side by side until step 7 deletes the rect system — resolving `office` to
 * the rect room keeps its existing behavior and tests unchanged). Standing a third of the way
 * in from the open (stair) edge, facing the center, the same framing rule `roomViewFromSlot`
 * uses for a rect room's door wall.
 *
 * Exported (issue #259): a mission war room is a hex room too — `BuildingLayout.roomView`/
 * `roomAt` use this same framing for one, rather than reimplementing it.
 */
export function hexRoomView(room: HexRoomGeometry, kind?: string): { bounds: THREE.Box3; standing: { position: THREE.Vector3; lookAt: THREE.Vector3 }; kind?: string } {
  const xs = room.corners.map((c) => c.x);
  const zs = room.corners.map((c) => c.z);
  const bounds = new THREE.Box3(
    new THREE.Vector3(Math.min(...xs), 0, Math.min(...zs)),
    new THREE.Vector3(Math.max(...xs), HEX_WALL_HEIGHT, Math.max(...zs)),
  );
  // The room's first stair (the office has two — the hub-facing one stands in for "the door").
  const openEdge = room.openEdges[0];
  const a = room.corners[openEdge];
  const b = room.corners[(openEdge + 1) % 6];
  const openMid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
  const toward = new THREE.Vector3(room.center.x - openMid.x, 0, room.center.z - openMid.z).normalize();
  const position = new THREE.Vector3(openMid.x, 0, openMid.z).addScaledVector(toward, room.radius * 0.6);
  position.y = FIGURE_EYE_HEIGHT;
  const lookAt = position.clone().addScaledVector(toward, 4);
  return { bounds, standing: { position, lookAt }, ...(kind ? { kind } : {}) };
}

function signElement(text: string): CSS2DObject {
  const element = document.createElement('div');
  element.className = 'desk-sign';
  element.textContent = text;
  Object.assign(element.style, {
    background: 'rgba(30, 32, 48, 0.85)', color: '#f5f0e8', padding: '2px 8px', borderRadius: '4px',
    font: '600 12px system-ui, sans-serif', whiteSpace: 'nowrap', pointerEvents: 'none',
  });
  return new CSS2DObject(element);
}

/**
 * Issue #260 step 7b, step 2: the hex Office's own desk and chair, built side by side with the
 * rect office's furniture (which keeps working, unconverted, until step 3 switches
 * `BuildingLayout`'s queue/desk-view/desk-talk-spot over and deletes the rect system outright).
 * `createDesk(false)`: no stock monitor (same reason the rect office's own desk drops it,
 * `furnishing.ts`'s `usersOffice` branch) — the hex office's own 2 small monitors are
 * `deskMonitors.ts`'s job once step 3 repoints that extension at this desk instead of building
 * a second, disconnected pair here. The chair is named `'desk-chair'` (`Desk.ts`'s own
 * convention) so `BuildingLayout`'s existing visibility toggle (issue #243, "hide the chair
 * while in desk mode") finds this one too, once step 3 wires it up.
 *
 * The "You" sign and the (initially hidden) queue-count sign reuse `rooms.ts`'s own CSS2D
 * styling and `QUEUE_COUNT_SIGN` name, so `BuildingLayout`'s existing sign-update code (which
 * already looks up `QUEUE_COUNT_SIGN` by name) finds this one too without a hex-specific branch.
 */
export function buildHexOfficeDesk(layout: HexOfficeLayout): THREE.Group {
  const frame = hexOfficeFrame(layout);
  const group = new THREE.Group();
  group.name = 'hex-office-desk';
  // One desk's own few materials (top, legs, chair seat/back, chair pole/base) would each cost
  // their own draw call as separate `Mesh`es (three.js never auto-batches by shared material);
  // the same `markStatic` merge every other hex zone already uses collapses them to one draw
  // call per material regardless of how many pieces share it — here, as everywhere else in
  // this file, that is a handful of calls total, not "zero", but still bounded and small.
  // `castShadow: false`, matching every other hex zone (this file's own top-of-file note: the
  // structure sits far from the rect hall's 3 shadow-casting ceiling lights, so a cast shadow
  // here buys nothing for 3x the draw-call cost — confirmed by measurement: `castShadow: true`
  // alone added 13 calls to the render-budget fixture, `false` added only the material count).
  markStatic(group, { zone: 'hex-office-desk', castShadow: false });

  const desk = createDesk(false);
  desk.position.copy(frame.point(HEX_OFFICE_DESK.a, HEX_OFFICE_DESK.d));
  // `frame.faceDoor` already points a piece toward the door (the Hub); the desk's own front
  // (where the chair sits, `Desk.ts`'s `+z`) should instead face away from the door, toward the
  // queue approaching from it — the same `FACE_AWAY` convention `furnishing.ts`'s rect office
  // plan uses for its own desk.
  desk.rotation.y = frame.faceAway;
  desk.castShadow = true;
  group.add(desk);

  const you = signElement('You');
  you.position.copy(frame.point(HEX_OFFICE_DESK.a, HEX_OFFICE_DESK.d + 0.7, 2.2));
  // A detail sign (`LabelDetail.ts`): shows when zoomed in or hovered, so it does not cover the
  // queue in the overview — the same treatment the rect office's own "You" sign got
  // (`furnishing.ts`'s `furnishOffice`, now gone). `rect` is the office's own AABB, the same
  // shape `hexRoomView`'s bounds already use.
  const officeXs = layout.office.corners.map((corner) => corner.x);
  const officeZs = layout.office.corners.map((corner) => corner.z);
  you.userData.detailSign = {
    rect: { minX: Math.min(...officeXs), maxX: Math.max(...officeXs), minZ: Math.min(...officeZs), maxZ: Math.max(...officeZs) },
    hoverOnly: false,
  };
  group.add(you);

  const queueCount = signElement('');
  queueCount.name = QUEUE_COUNT_SIGN;
  queueCount.userData.queueCount = 0;
  queueCount.visible = false;
  queueCount.position.copy(frame.point(HEX_OFFICE_DESK.a, HEX_OFFICE_DESK.d + 0.7, 2.5));
  group.add(queueCount);

  return group;
}

export interface BuiltHexOffice {
  group: THREE.Group;
  layout: HexOfficeLayout;
  wallColliders: WallRect[];
  surfaceHeightAt(x: number, z: number): number | null;
  /** Issue #260 (step 7a part a): the Hub's own fixed open-office stations — a spare desk
   * (type `implementing`) per spot, and an idle spot near the kitchen/play corner, for
   * `BuildingLayout.ts` to register once, same as the hex Library's own stations. */
  hubDeskSpots: Array<{ position: THREE.Vector3; lookAt: THREE.Vector3 }>;
  hubIdleSpots: Array<{ position: THREE.Vector3; lookAt: THREE.Vector3 }>;
  /** Issue #260 step 7b item 4: the Hub's own fixed test stations — the rect hall's two test
   * stations (`Office.ts`'s `test_0`/`test_1`) had no hex home at all until now. */
  hubTestSpots: Array<{ position: THREE.Vector3; lookAt: THREE.Vector3 }>;
  /** `#room=hub` / `#room=hex-office` (issue #242 review). Unknown names return null, the
   * same contract `BuildingLayout.roomView` already keeps for a rect room. */
  roomView(name: string): { bounds: THREE.Box3; standing: { position: THREE.Vector3; lookAt: THREE.Vector3 }; kind?: string } | null;
  /** The hex room (if any) whose floor contains this world point (issue #249: a double-click
   * in isometric only ever checked the rect rooms, so clicking a hex room floor did nothing).
   * The same contract `BuildingLayout.roomAt` already keeps for a rect room. */
  roomAt(x: number, z: number): { bounds: THREE.Box3; standing: { position: THREE.Vector3; lookAt: THREE.Vector3 }; kind?: string } | null;
}

/** Builds the Hub and Office hex rooms and the walkway/stair between them, merged into one
 * static batch per shared material (4 draw calls total: walls, floors, walkway, Hub accents).
 * Pure placement comes from `buildHexOfficeLayout()` — deterministic, same every call. */
export function buildHexOffice(counts?: HexWorldCounts): BuiltHexOffice {
  const layout = counts ? buildHexWorld(counts) : buildHexOfficeLayout();
  const group = new THREE.Group();
  group.name = 'hex-office';

  // Issue #258 steps 5/6: every claimed room (`layout.rooms`), not just the 3 named ones —
  // a component wing's war rooms share these same 3 zones, so a wing of any size still costs
  // exactly these 3 draw calls, never one more per room (the render-budget note above).
  const wallMaterial = getToonMaterial(HEX_WALL_COLOR);
  const walls = new THREE.Group();
  walls.name = 'hex-walls';
  // overviewLower (review, #242): without it this zone has no cutaway height, so these
  // walls stay full height in isometric overview and occlude the Hub furniture behind them —
  // the same `overviewLower: WALL_HEIGHT` every rect room's walls already carry.
  markStatic(walls, { zone: 'hex-walls', castShadow: false, overviewLower: HEX_WALL_HEIGHT });
  for (const room of layout.rooms) {
    for (const wall of buildHexWalls(room, wallMaterial)) walls.add(wall);
  }
  group.add(walls);

  const floors = new THREE.Group();
  floors.name = 'hex-floors';
  markStatic(floors, { zone: 'hex-floors', castShadow: false });
  for (const room of layout.rooms) floors.add(buildHexFloor(room, HEX_FLOOR_COLOR));
  group.add(floors);

  const walkwayMaterial = getToonMaterial(WALKWAY_COLOR);
  const walkway = new THREE.Group();
  walkway.name = 'hex-walkway';
  markStatic(walkway, { zone: 'hex-walkway', castShadow: false });
  for (const connection of layout.connections) {
    walkway.add(orientedBox(v3(connection.parentRamp.from, 0), v3(connection.parentRamp.to, WALKWAY_HEIGHT), WALKWAY_DECK_THICKNESS, WALKWAY_WIDTH, walkwayMaterial));
    walkway.add(orientedBox(v3(connection.childRamp.from, 0), v3(connection.childRamp.to, WALKWAY_HEIGHT), WALKWAY_DECK_THICKNESS, WALKWAY_WIDTH, walkwayMaterial));
    walkway.add(orientedBox(v3(connection.parentRamp.to, WALKWAY_HEIGHT), v3(connection.childRamp.to, WALKWAY_HEIGHT), WALKWAY_DECK_THICKNESS, WALKWAY_WIDTH, walkwayMaterial));
  }
  group.add(walkway);

  const accents = new THREE.Group();
  accents.name = 'hex-hub-accents';
  markStatic(accents, { zone: 'hex-accents', castShadow: false });
  const elevator = buildElevator();
  // Opposite the stair, against the Hub's own back wall, clear of the walkway opening.
  const hubBack = layout.hub.corners[(layout.hub.openEdges[0] + 3) % 6];
  elevator.position.set((layout.hub.center.x + hubBack.x) / 2, 0, (layout.hub.center.z + hubBack.z) / 2);
  elevator.lookAt(layout.hub.center.x, 0, layout.hub.center.z);
  accents.add(elevator);
  const kitchen = buildKitchenCorner();
  const hubSide = layout.hub.corners[(layout.hub.openEdges[0] + 2) % 6];
  kitchen.position.set((layout.hub.center.x + hubSide.x) / 2, 0, (layout.hub.center.z + hubSide.z) / 2);
  kitchen.lookAt(layout.hub.center.x, 0, layout.hub.center.z);
  accents.add(kitchen);
  // Issue #260 step 7b item 4: the tool crib moves out of the rect hall (`Office.ts`, its only
  // home until now) into real hub furniture — same zone as the elevator/kitchen, so it still
  // costs only its own material count, not a whole new draw-call bucket of its own.
  const toolCrib = createToolCrib();
  const cribSpot = hubToolCribSpot(layout.hub);
  toolCrib.position.set(cribSpot.x, 0, cribSpot.z);
  toolCrib.lookAt(layout.hub.center.x, 0, layout.hub.center.z);
  accents.add(toolCrib);
  group.add(accents);

  // Issue #260 (step 7a part a): the Hub's own fixed open-office capacity — spare desks for a
  // session with no mission, once the hall's own desks are full. One real furniture-library
  // piece per desk (not a placeholder, unlike the elevator/kitchen accents above: a desk is
  // where an agent visibly sits and works, so it needs to read as a desk up close), merged into
  // its own zone — one draw call for however many spare desks the Hub carries.
  const hubFurniture = hubFurnitureSpots(layout.hub);
  const hubDesks = new THREE.Group();
  hubDesks.name = 'hex-hub-desks';
  markStatic(hubDesks, { zone: 'hex-hub-desks', castShadow: false });
  const hubDeskSpots: Array<{ position: THREE.Vector3; lookAt: THREE.Vector3 }> = [];
  for (const spot of hubFurniture.desks) {
    const desk = createDesk(true);
    desk.position.set(spot.position.x, 0, spot.position.z);
    desk.lookAt(spot.lookAt.x, 0, spot.lookAt.z);
    hubDesks.add(desk);
    // `Desk.ts`'s monitor sits on the local -Z side (`Office.ts`'s own desk stations: the agent
    // sits at `z + 0.7`, looking toward the monitor at `z - 0.15`); `lookAt` above turns -Z to
    // face the Hub's own center, so +Z (the seated side) now faces away from it — the same
    // "agent sits further out, facing in toward the monitor" shape every hall desk already has.
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(desk.quaternion);
    hubDeskSpots.push({
      position: desk.position.clone().addScaledVector(forward, 0.7),
      lookAt: desk.position.clone().addScaledVector(forward, -0.15).setY(1.2),
    });
  }
  group.add(hubDesks);

  const hubIdleSpots: Array<{ position: THREE.Vector3; lookAt: THREE.Vector3 }> = hubFurniture.idle.map((spot) => ({
    position: new THREE.Vector3(spot.position.x, 0, spot.position.z),
    lookAt: new THREE.Vector3(spot.lookAt.x, 1.0, spot.lookAt.z),
  }));

  // Issue #260 step 7b item 4: the Hub's own fixed test stations, the same "one real piece of
  // furniture per spot" treatment the spare desks above get, own zone so it costs its own
  // material count regardless of how many stations exist (2 today, fixed, same as the Hub
  // never growing past its own spare-desk count).
  const hubTests = new THREE.Group();
  hubTests.name = 'hex-hub-test';
  markStatic(hubTests, { zone: 'hex-hub-test', castShadow: false });
  const hubTestSpots: Array<{ position: THREE.Vector3; lookAt: THREE.Vector3 }> = [];
  for (const spot of hubFurniture.testing) {
    const testStation = createTestStation();
    testStation.position.set(spot.position.x, 0, spot.position.z);
    testStation.lookAt(spot.lookAt.x, 0, spot.lookAt.z);
    hubTests.add(testStation);
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(testStation.quaternion);
    hubTestSpots.push({
      position: testStation.position.clone().addScaledVector(forward, 0.9),
      lookAt: testStation.position.clone().addScaledVector(forward, -0.15).setY(1.4),
    });
  }
  group.add(hubTests);

  // Issue #258 review (the floor-library plugin's NPC/shelves went dark the moment the rect
  // library room they keyed off, `room-N-library`, was deleted): an invisible, zero-geometry
  // marker, found by name the same way that plugin already finds a rect room, carrying the
  // hex library's own door-wall frame as plain data — no rect assumptions, no `RoomPlanner`
  // import needed on the plugin's side.
  const libraryMarker = new THREE.Object3D();
  libraryMarker.name = 'hex-library-room';
  libraryMarker.userData.libraryFrame = hexRoomFrame(layout.library, layout.library.openEdges[0]);
  // A plain axis-aligned bounding rect of the hexagon, for the same "is the camera/cursor
  // inside this room" checks `LabelDetail.ts`'s `DetailSign.rect` already does for a rect
  // room — conservative (a touch larger than the hex itself at the corners), fine for that
  // coarse a check.
  const libraryXs = layout.library.corners.map((c) => c.x);
  const libraryZs = layout.library.corners.map((c) => c.z);
  libraryMarker.userData.libraryBounds = {
    minX: Math.min(...libraryXs), maxX: Math.max(...libraryXs),
    minZ: Math.min(...libraryZs), maxZ: Math.max(...libraryZs),
  };
  group.add(libraryMarker);

  // Issue #260 step 7b, step 2: the hex Office's own desk, chair and signs — side by side with
  // the rect office's, not wired to the real queue/desk-view/desk-talk-spot yet (step 3's job).
  const officeDesk = buildHexOfficeDesk(layout);
  group.add(officeDesk);

  // Issue #242 review (root cause of the "very dark" finding): the scene's only real light
  // sources are 3 fixed ceiling spotlights over the rect hall (`SceneSetup.ts`'s
  // `addLighting`), each with `distance: 20` — nowhere near this structure's `HEX_OFFSET`.
  // Ambient and hemisphere light alone render a `MeshToonMaterial` quite dark. A real ceiling
  // lamp (`CeilingLamp.ts`) would fix it too, but its fixture mesh costs its own draw calls
  // per instance (no shared zone) — unaffordable at 2 points of headroom. A bare point light,
  // no fixture mesh, `castShadow: false`, costs nothing in `countDrawCalls` (lights only count
  // when they cast a shadow) and fixes the actual cause directly.
  const hubLight = new THREE.PointLight(0xfff5e6, 18, 25, 1);
  hubLight.position.set(layout.hub.center.x, HEX_WALL_HEIGHT - 0.5, layout.hub.center.z);
  hubLight.castShadow = false;
  group.add(hubLight);
  const officeLight = new THREE.PointLight(0xfff5e6, 14, 20, 1);
  officeLight.position.set(layout.office.center.x, HEX_WALL_HEIGHT - 0.5, layout.office.center.z);
  officeLight.castShadow = false;
  group.add(officeLight);

  return {
    group,
    layout,
    wallColliders: hexWallColliders(layout),
    surfaceHeightAt: (x: number, z: number) => hexSurfaceHeightAt(layout, x, z),
    hubDeskSpots,
    hubIdleSpots,
    hubTestSpots,
    roomView: (name: string) => {
      const query = name.trim().toLowerCase();
      if (query === 'hub') return hexRoomView(layout.hub);
      // Issue #260 steps 2+3: the rect office is gone, along with the `#room=office` path that
      // used to frame it (`BuildingLayout.ts`'s own deleted rect lookup) — `office` keeps
      // working as a `hex-office` alias so a bookmarked or documented `#room=office` link
      // (`Selection.ts`'s own doc comment) still resolves, to the one office that is left.
      if (query === 'hex-office' || query === 'office') return hexRoomView(layout.office);
      // Issue #258: `kind: 'library'` is load-bearing — `ViewController` already special-cases
      // it (walking in or double-clicking it swaps to the library's own scene, issue #239)
      // for whichever room carries it, rect or hex.
      if (query === 'library') return hexRoomView(layout.library, 'library');
      return null;
    },
    roomAt: (x: number, z: number) => {
      const point = { x, z };
      if (pointInPolygon(point, layout.hub.corners)) return hexRoomView(layout.hub);
      if (pointInPolygon(point, layout.office.corners)) return hexRoomView(layout.office);
      if (pointInPolygon(point, layout.library.corners)) return hexRoomView(layout.library, 'library');
      return null;
    },
  };
}
