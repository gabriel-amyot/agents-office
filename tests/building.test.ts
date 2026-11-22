import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import { HALL, rectsOverlap, slotFor, wallPieces } from '../src/addons/building/RoomPlanner.js';
import type { Activity } from '../src/agents/ActivityAnimations.js';
import type { AgentExtras } from '../src/agents/AgentData.js';

// Furniture paints toon gradients on a canvas; room signs need a document.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { BuildingLayout, BUILDING_STORAGE_KEY, floorStorageKey, dropLegacyRoomStorage, ROOMS_DROPPED_KEY } = await import('../src/addons/building/BuildingLayout.js');
const { testHexWarRoom, combinedBoard } = await import('../src/addons/building/missionRooms.js');
const { projectWorld } = await import('../server/seam.js');

/** A hex room's own AABB (issue #259), the same shape `missionSlot(index).rect` used to give
 * these tests for the first (ordinal-0, default-wing) mission a fresh layout ever builds. */
function hexRoomRect(room: ReturnType<typeof testHexWarRoom>) {
  const xs = room.corners.map((c) => c.x);
  const zs = room.corners.map((c) => c.z);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

/** The same hashing `server/vitePlugin.ts` uses for `publicId`, with its own random key held
 * for the whole call (one key, so the same raw string always hashes the same, the way one
 * server run does): a room's real client-facing `id` never carries the raw `mission:<slug>`
 * key it came from (issue #89 review, fix 2 — `roomView` must match through this, not an
 * injected raw id). */
function createFakePublicId(): (raw: string) => string {
  const key = randomBytes(32).toString('hex');
  return (raw: string) => createHmac('sha256', key).update(raw).digest('hex');
}
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

// --- Planner ---

test('the first ring of rooms surrounds the hall without overlap, the office first on the east side', () => {
  const slots = Array.from({ length: 7 }, (_, i) => slotFor(i));
  assert.deepEqual(slots[0].rect, { minX: 15, maxX: 27, minZ: -6, maxZ: 6 });
  for (let i = 0; i < slots.length; i++) {
    assert.equal(rectsOverlap(slots[i].rect, HALL), false, `slot ${i} overlaps the hall`);
    for (let j = i + 1; j < slots.length; j++) assert.equal(rectsOverlap(slots[i].rect, slots[j].rect), false, `${i} overlaps ${j}`);
  }
});

test('an outer room sits one room further out and opens toward the room inside it', () => {
  const outer = slotFor(7);
  assert.deepEqual(outer.rect, { minX: 27, maxX: 39, minZ: -6, maxZ: 6 });
  assert.deepEqual(outer.door, { side: 'west', at: 0 });
  assert.equal(outer.ring, 1);
});

test('walls leave a door-wide gap at each door', () => {
  const pieces = wallPieces({ minX: 0, maxX: 12, minZ: 0, maxZ: 12 }, [{ side: 'west', at: 6 }]).filter((p) => p.side === 'west');
  assert.deepEqual(pieces, [{ side: 'west', from: 0, to: 4.8 }, { side: 'west', from: 7.2, to: 12 }]);
});

// --- Layout ---

function setup(storage = new Map<string, string>(), floor?: string) {
  let clock = 0;
  let wallClock = Date.parse('2026-11-20T00:00:00Z');
  const scene = new THREE.Scene();
  // Issue #260 step 7b item 6: `createOffice` (the rect hall) never ran in production for the
  // 'building' layout (`main.ts`'s own `layoutId === 'activity' ? createOffice(scene) : new
  // Map()`, step 4) — an empty `Map` matches it; `BuildingLayout`'s own constructor builds the
  // hex structure regardless.
  const layout = new BuildingLayout(scene, new Map(), {
    now: () => clock,
    wallClock: () => wallClock,
    dwellMs: 4000,
    storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v) },
    ...(floor ? { floor } : {}),
  });
  const agent = (id: string, activity: Activity, extras?: AgentExtras) => ({ id, activity, ...(extras ? { extras } : {}) });
  return {
    scene, layout, storage, agent,
    tick: (ms: number) => { clock += ms; wallClock += ms; return layout.update(); },
  };
}

// --- Floors (issue #118): `floorStorageKey` is still the legacy rect-rooms key shape
// `dropLegacyRoomStorage` sweeps and `FloorRegistry.ts` cross-checks, even with no rect room
// left to save under it (issues #260 steps 2+3). ---

test('floorStorageKey namespaces the legacy key by floor; without a floor it stays the legacy key', () => {
  assert.equal(floorStorageKey('agents-office'), `${BUILDING_STORAGE_KEY}:agents-office`);
  assert.equal(floorStorageKey(), BUILDING_STORAGE_KEY);
});

test('an agent that queues for Gabriel seats in the lobby queue regardless of what floor its own extras name: a building never filters its queue by floor', () => {
  const { layout, agent, tick } = setup();
  // `floor` is carried on `extras` the same way the server projects it; `BuildingLayout`
  // never reads it — floor scoping is the poller's job (issue #192: the office is shared,
  // not rebuilt per floor, so the one building on screen must seat whoever reaches it).
  const home = layout.seatFor(agent('local', 'implementing'), null)!;
  const seat = layout.seatFor(agent('visitor', 'meeting', { attention: 'waiting', waitMinutes: 3, floor: 'widget-service' }), null)!;

  assert.notEqual(seat.key, home.key);
  tick(600); // past QUEUE_REFRESH_MS: orderQueue runs and claims a queue spot
  assert.ok(layout.isQueued('visitor'), 'a cross-floor waiting agent queues at the one shared office, the same as a local one');
});

test('an agent keeps its home desk, makes a trip after the dwell time, and comes back to the same desk', () => {
  const { layout, agent, tick } = setup();
  const home = layout.seatFor(agent('a', 'implementing'), null)!;

  assert.equal(layout.seatFor(agent('a', 'testing'), 'implementing'), null, 'no move before the dwell time');
  assert.deepEqual(tick(3000).filter((m) => m.agentId === 'a'), []);
  const trip = tick(1500).find((m) => m.agentId === 'a')!;
  assert.match(trip.seat.key, /^hex-hub-test-/);

  layout.seatFor(agent('a', 'debugging'), 'testing');
  const back = tick(4500).find((m) => m.agentId === 'a')!;
  assert.equal(back.seat.key, home.key);
});

test('a non-librarian keeps its home desk through a research activity: no trip, no move at all (issue #128 AC2)', () => {
  const { layout, agent, tick } = setup();
  const home = layout.seatFor(agent('a', 'implementing'), null)!;

  assert.equal(layout.seatFor(agent('a', 'researching'), 'implementing'), null, 'the target does not change, so there is nothing to move to after the dwell time');
  assert.deepEqual(tick(4500).filter((m) => m.agentId === 'a'), []);

  layout.seatFor(agent('a', 'debugging'), 'researching');
  assert.deepEqual(tick(4500).filter((m) => m.agentId === 'a'), [], 'still at the same desk the whole time');
  assert.equal(layout.seatFor(agent('a', 'implementing'), 'debugging'), null);
});

test('a planning agent with no war room stays at its desk, not the lounge (#131)', () => {
  const { layout, agent, tick } = setup();
  const home = layout.seatFor(agent('a', 'implementing'), null)!;
  assert.equal(layout.seatFor(agent('a', 'planning'), 'implementing'), null, 'planning is desk work: no move pending');
  assert.deepEqual(tick(5000).filter((m) => m.agentId === 'a'), [], 'no trip ever starts for planning');
  assert.equal(layout.seatFor(agent('a', 'debugging'), 'planning'), null, 'still the same desk');
});

test('an agent with no war room that writes docs stays at its desk, not the lounge (#141)', () => {
  const { layout, agent, tick } = setup();
  const home = layout.seatFor(agent('a', 'implementing'), null)!;
  assert.equal(layout.seatFor(agent('a', 'writing_docs'), 'implementing'), null, 'writing docs is desk work: no move pending');
  assert.deepEqual(tick(5000).filter((m) => m.agentId === 'a'), [], 'no trip ever starts for writing docs');
  assert.equal(layout.seatFor(agent('a', 'reviewing'), 'writing_docs'), null, 'still the same desk');
});

test('a short tool call does not make the agent walk', () => {
  // Uses 'testing' (not 'researching', issue #128 review): a non-librarian's research no
  // longer creates a pending trip at all, so it could no longer prove cancellation works.
  const { layout, agent, tick } = setup();
  layout.seatFor(agent('a', 'implementing'), null);
  layout.seatFor(agent('a', 'testing'), 'implementing');
  tick(1000);
  layout.seatFor(agent('a', 'implementing'), 'testing');
  assert.deepEqual(tick(5000).filter((m) => m.agentId === 'a'), []);
});

test('agents blocked on the user go straight to the office and line up by how long they waited', () => {
  const { layout, agent, tick } = setup();
  for (const [id, wait] of [['short', 1], ['long', 10], ['mid', 5]] as const) {
    layout.seatFor(agent(id, 'implementing'), null);
    const seat = layout.seatFor(agent(id, 'meeting', { attention: 'waiting', waitMinutes: wait }), 'implementing');
    assert.match(seat!.key, /^hex-office-queue-/, `${id} goes to the office at once`);
  }
  tick(600);
  const spotOf = (id: string) => (layout as unknown as { agents: Map<string, { seat: string }> }).agents.get(id)!.seat;
  assert.deepEqual(['long', 'mid', 'short'].map(spotOf), ['hex-office-queue-0', 'hex-office-queue-1', 'hex-office-queue-2']);

  layout.release('long');
  const moves = tick(600);
  assert.deepEqual(moves.map((m) => [m.agentId, m.seat.key]).sort(), [['mid', 'hex-office-queue-0'], ['short', 'hex-office-queue-1']]);
});

test('the queue puts fresh waits before aging ones, the oldest first inside each band, your turn included', () => {
  const { layout, agent, tick } = setup();
  const waits = [['aging-young', 'waiting', 20], ['fresh-young', 'your-turn', 1], ['aging-old', 'your-turn', 600], ['fresh-old', 'waiting', 14]] as const;
  for (const [id, attention, wait] of waits) {
    layout.seatFor(agent(id, 'implementing'), null);
    const activity = attention === 'waiting' ? 'meeting' : 'idle';
    const seat = layout.seatFor(agent(id, activity, { attention, waitMinutes: wait }), 'implementing');
    assert.match(seat!.key, /^hex-office-queue-/, `${id} goes to the office at once`);
  }
  tick(600);
  const spotOf = (id: string) => (layout as unknown as { agents: Map<string, { seat: string }> }).agents.get(id)!.seat;
  assert.deepEqual(['fresh-old', 'fresh-young', 'aging-old', 'aging-young'].map(spotOf),
    ['hex-office-queue-0', 'hex-office-queue-1', 'hex-office-queue-2', 'hex-office-queue-3']);
});

test('14 waiting agents fill three rows, longest wait at the front, a new one joins at the back and a leaver closes up the line (#132)', () => {
  const { layout, agent, tick } = setup();
  // Longest wait first: a14 waited 14 minutes, a1 waited 1.
  for (let i = 14; i >= 1; i--) {
    const id = `a${i}`;
    layout.seatFor(agent(id, 'implementing'), null);
    const seat = layout.seatFor(agent(id, 'meeting', { attention: 'waiting', waitMinutes: i }), 'implementing');
    assert.match(seat!.key, /^hex-office-queue-/, `${id} goes to the office at once`);
  }
  tick(600);
  const spotOf = (id: string) => (layout as unknown as { agents: Map<string, { seat: string }> }).agents.get(id)!.seat;
  const seats = Array.from({ length: 14 }, (_, i) => spotOf(`a${14 - i}`));
  assert.deepEqual(seats, Array.from({ length: 14 }, (_, i) => `hex-office-queue-${i}`), 'the longest wait (a14) holds queue_0, the front of the line');

  // A new wait joins at the back.
  layout.seatFor(agent('new', 'implementing'), null);
  layout.seatFor(agent('new', 'meeting', { attention: 'waiting', waitMinutes: 0 }), 'implementing');
  tick(600);
  assert.equal(spotOf('new'), 'hex-office-queue-14', 'the newest, shortest wait joins at the back');

  // The front of the line leaves; everyone behind it closes up by one spot.
  layout.release('a14');
  tick(600);
  assert.equal(spotOf('a13'), 'hex-office-queue-0', 'the next-longest wait now leads the line');
  assert.equal(spotOf('new'), 'hex-office-queue-13', 'the line closed up behind the agent that left');
});

test('a cold wait leaves the queue for the lounge and never joins it', () => {
  const { layout, agent, tick } = setup();
  layout.seatFor(agent('b', 'implementing'), null);
  assert.match(layout.seatFor(agent('b', 'meeting', { attention: 'waiting', waitMinutes: 600 }), 'implementing')!.key, /^hex-office-queue-/);
  assert.equal(layout.seatFor(agent('b', 'meeting', { attention: 'waiting', waitMinutes: 24 * 60 }), 'meeting'), null, 'leaves after the dwell time');
  const leave = tick(4500).find((m) => m.agentId === 'b')!;
  assert.doesNotMatch(leave.seat.key, /queue/);

  const cold = layout.seatFor(agent('c', 'idle', { attention: 'your-turn', waitMinutes: 3 * 24 * 60 }), null)!;
  assert.doesNotMatch(cold.key, /queue/);
});

test('your turn without a wait time stays out of the queue, as before', () => {
  const { layout, agent } = setup();
  const seat = layout.seatFor(agent('y', 'idle', { attention: 'your-turn' }), null)!;
  assert.doesNotMatch(seat.key, /queue/);
});

// Issue #260 (step 7a): the rented 'desks' room is gone — overflow past the hall's own 8 desks
// goes to the hex Hub's own spare desks instead of a new rect room.
test('the hall desks overflow onto the hex hub\'s own spare desks, never a rented room', () => {
  const { layout, agent } = setup();
  const seats = Array.from({ length: 10 }, (_, i) => layout.seatFor(agent(`s${i}`, 'implementing'), null)!);
  assert.equal(new Set(seats.map((s) => s.key)).size, 10);
  assert.ok(seats.some((seat) => seat.key.startsWith('hex-hub-desk-')), 'the overflow desks are the hub\'s own');
});

// Issue #260: idle overflow past the hall's own coffee/sofa spots goes to the hex Hub's own
// kitchen/play corner instead of a rented lounge room.
test('idle agents beyond the hall seats overflow onto the hex hub\'s own idle spots, never a rented lounge', () => {
  const { layout, agent } = setup();
  const seats = Array.from({ length: 10 }, (_, i) => layout.seatFor(agent(`i${i}`, 'idle'), null)!);
  assert.ok(seats.some((seat) => seat.key.startsWith('hex-hub-idle-')), 'the overflow idle spots are the hub\'s own');
});

// Issue #260 step 7b item 4: the hex Hub carries its own 2 fixed test stations (the rect
// hall's own 2 test stations had no hex home at all until then; step 7b item 6: the rect hall
// itself is gone now, so the hub's own 2 are the only fixed test stations left) — both testing
// agents get a real test station, neither falling back to the idle corner.
test('testing fills the hub\'s 2 fixed test stations before any overflow (issue #260 step 7b item 4)', () => {
  const { layout, agent } = setup();
  const seats = Array.from({ length: 2 }, (_, i) => layout.seatFor(agent(`t${i}`, 'testing'), null)!);
  assert.equal(new Set(seats.map((s) => s.key)).size, 2);
  assert.ok(seats.every((seat) => seat.key.startsWith('hex-hub-test-')), 'both testers sit at the hub\'s own stations');
});

test('testing overflow past the hub\'s 2 test stations falls back to the idle corner, not a rented lab (issue #260)', () => {
  const { layout, agent } = setup();
  const seats = Array.from({ length: 5 }, (_, i) => layout.seatFor(agent(`t${i}`, 'testing'), null)!);
  assert.ok(seats.some((seat) => seat.key.includes('coffee') || seat.key.includes('sofa') || seat.key.startsWith('hex-hub-idle-')));
});

test('subagents gather around their parent desk', () => {
  const { layout, agent } = setup();
  const desk = layout.seatFor(agent('parent', 'implementing'), null)!;
  const helper = layout.seatFor(agent('child', 'researching', { parentId: 'parent' }), null)!;
  assert.match(helper.key, /_pod\d$/);
  assert.ok(helper.position.distanceTo(desk.position) < 2);
});

// --- Mission war rooms ---

const missionRoom = (state: 'open' | 'locked' = 'open') => ({
  id: 'room-1', kind: 'mission' as const, title: 'Office roadmap', state,
  sleepers: [{ id: 'tomb-1' }, { id: 'tomb-2' }, { id: 'tomb-3' }],
  walls: { statement: 'Ship it', docs: ['Explainer'], issues: [{ number: 46, title: 'Parent', state: 'open' as const }], kanban: [] },
});

// Issue #259: a mission becomes a hex war room in its own component wing now, not a rect room
// chained to the hall through the mission corridor (deleted) — the hall never gets a door for
// it at all; it is reachable only through the hex structure's own Hub and walkway.
test('a mission becomes a hex war room, reachable by name and never through the hall', () => {
  const { layout, scene } = setup();
  layout.syncWorldRooms([missionRoom()]);
  assert.equal(layout.missionRoomCount, 1);
  const room = scene.getObjectByName('mission-room-0')!;
  assert.ok(room, 'the mission room group exists');
  assert.equal(room.children.some((c) => c.userData.floor), false, 'no floor of its own: the hex zones already draw one');
  assert.ok(layout.roomView('room-1'), 'reachable by its own public id, the same as any other room');
});

test('agents of a mission work in its war room, their helpers stand near them, and a locked room keeps them out', () => {
  const { layout, agent } = setup();
  layout.syncWorldRooms([missionRoom()]);
  const seat = layout.seatFor(agent('s', 'implementing', { room: 'room-1' }), null)!;
  assert.match(seat.key, /^mission0_/);
  const helper = layout.seatFor(agent('h', 'researching', { parentId: 's' }), null)!;
  assert.match(helper.key, /^mission0_.+_pod\d$/);

  layout.syncWorldRooms([missionRoom('locked')]);
  const late = layout.seatFor(agent('late', 'implementing', { room: 'room-1' }), null)!;
  assert.doesNotMatch(late.key, /^mission/);
});

// --- Issue #223: the display wall's live-sessions list, through the real BuildingLayout ---

// uv values ground-truthed against `drawSectionedBoardContent`'s own pixel layout (2 equal
// 128 px sections, flipY texture; title at `top + 30`, rows at `top + 60 + j * 19`), not an
// assumed even split — see the review fix in `missionRooms.ts`'s `resolveSessionRow`.
//
// Issue #223 vs #244: the kanban board (and its sessions section) lives inside
// `combinedBoard`'s shared canvas, its own region (index 2 of the same 3 specs
// `buildMissionRoom` passes it — only `width`/`height` affect a region's own bounds), so a
// hit's `uv.y` is in that shared canvas's full UV space, not a region-local [0, 1].
// Issue #259 review round 2: the display wall's own board grid shrank along with the room
// (BOARD_W/BOARD_H, `buildMissionRoom`'s own constants) — same 3 specs, smaller dimensions.
const kanbanRegion = combinedBoard([
  { width: 1.4, height: 0.8, position: new THREE.Vector3(), rotationY: 0 },
  { width: 1.4, height: 0.8, position: new THREE.Vector3(), rotationY: 0 },
  { width: 1.4, height: 0.8, position: new THREE.Vector3(), rotationY: 0 },
]).regionOf(2);
const SECTION_TOP_PX = kanbanRegion.h / 2;
const uvForCanvasY = (y: number) => kanbanRegion.vBottom + (1 - y / kanbanRegion.h) * (kanbanRegion.vTop - kanbanRegion.vBottom);

test('the sessions board picks up a mission\'s own live agents on the next tick, by agent.extras.room', () => {
  const { layout, agent, tick } = setup();
  layout.syncWorldRooms([missionRoom()]);
  layout.seatFor(agent('blocked-one', 'implementing', { room: 'room-1', stuck: true }), null);
  layout.seatFor(agent('working-one', 'researching', { room: 'room-1' }), null);
  tick(0);

  const [target] = layout.sessionsBoardPickTargets();
  assert.ok(target, 'one war room, one sessions board target');
  // Row 0 (drawn at `top + 60`) is "blocked" (ranked first); row 1 (`top + 79`) is "working"
  // (the only other state present).
  const hitAt = (v: number) => target.resolve!({ uv: new THREE.Vector2(0.5, v) } as THREE.Intersection);
  assert.equal(hitAt(uvForCanvasY(SECTION_TOP_PX + 60)), 'blocked-one');
  assert.equal(hitAt(uvForCanvasY(SECTION_TOP_PX + 79)), 'working-one');
});

test('an idle session still shows on its mission\'s sessions board, even though it physically sits in the lounge', () => {
  const { layout, agent, tick } = setup();
  layout.syncWorldRooms([missionRoom()]);
  layout.seatFor(agent('idler', 'idle', { room: 'room-1' }), null);
  tick(0);

  const [target] = layout.sessionsBoardPickTargets();
  assert.equal(target.resolve!({ uv: new THREE.Vector2(0.5, uvForCanvasY(SECTION_TOP_PX + 60)) } as THREE.Intersection), 'idler');
});

// --- Issue #191: a floor shows only its own mission war rooms ---

/** The title text actually drawn on a built mission room's own label, by its scene index
 * (`mission-room-<n>`, `buildMissionRoom`'s own naming) — identity, not just a count (review:
 * a filter that kept the wrong room would still pass a count-only assertion). */
function missionRoomTitles(scene: THREE.Scene, count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const group = scene.getObjectByName(`mission-room-${index}`)!;
    let title: string | undefined;
    group.traverse((child) => { if (child.name === 'room-label') title = child.userData.roomLabel as string; });
    return title!;
  });
}

test('on a specific floor, only a mission room whose repo matches it is built; "all floors" keeps building every one', () => {
  const widget = { ...missionRoom(), id: 'room-2', title: 'Widget migration', repo: 'widget-service' };
  const own = { ...missionRoom(), title: 'Office roadmap', repo: 'agents-office' };

  const onFloor = setup(new Map(), 'agents-office');
  onFloor.layout.syncWorldRooms([own, widget]);
  assert.equal(onFloor.layout.missionRoomCount, 1);
  assert.deepEqual(missionRoomTitles(onFloor.scene, 1), ['Office roadmap'], 'the matching room survived, not just any one room');

  const allFloors = setup();
  allFloors.layout.syncWorldRooms([own, widget]);
  assert.equal(allFloors.layout.missionRoomCount, 2);
  assert.deepEqual(missionRoomTitles(allFloors.scene, 2), ['Office roadmap', 'Widget migration']);
});

test('an org-qualified floor still matches a mission tagged with the bare repo name', () => {
  const own = { ...missionRoom(), repo: 'agents-office' };
  const { layout } = setup(new Map(), 'gabriel-amyot/agents-office');
  layout.syncWorldRooms([own]);
  assert.equal(layout.missionRoomCount, 1);
});

test('on a specific floor, a mission room with no repo tag at all never builds (it only ever shows on "all floors")', () => {
  const { layout } = setup(new Map(), 'agents-office');
  layout.syncWorldRooms([missionRoom()]);
  assert.equal(layout.missionRoomCount, 0);
});

// --- Issue #260 steps 2+3: BuildingLayout no longer rents rect rooms, so `addRoom`,
// `saveRooms` and the old `migrateLegacyRooms` are gone — a returning browser's legacy
// room-kind-list keys are dead data now, swept once by `dropLegacyRoomStorage` instead. ---

function legacyStorage(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const backing: Pick<Storage, 'getItem' | 'setItem' | 'length' | 'key' | 'removeItem'> = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
    get length() { return store.size; },
    key: (index) => [...store.keys()][index] ?? null,
  };
  return { store, backing };
}

test('dropLegacyRoomStorage removes the legacy bare key and every floor-scoped key sharing its prefix', () => {
  const { store, backing } = legacyStorage({
    [BUILDING_STORAGE_KEY]: JSON.stringify(['office', 'library', 'desks']),
    [floorStorageKey('agents-office')]: JSON.stringify(['office']),
    [floorStorageKey('widget-service')]: JSON.stringify(['office', 'lounge']),
    'agents-office.unrelated-key': 'untouched',
  });
  dropLegacyRoomStorage(backing);
  assert.equal(store.has(BUILDING_STORAGE_KEY), false);
  assert.equal(store.has(floorStorageKey('agents-office')), false);
  assert.equal(store.has(floorStorageKey('widget-service')), false);
  assert.equal(store.get('agents-office.unrelated-key'), 'untouched', 'a key that only shares a prefix loosely is never swept');
});

test('dropLegacyRoomStorage runs once: a second call leaves other keys written since alone', () => {
  const { store, backing } = legacyStorage({ [BUILDING_STORAGE_KEY]: '["office"]' });
  dropLegacyRoomStorage(backing);
  assert.ok(store.has(ROOMS_DROPPED_KEY));
  store.set(floorStorageKey('late-floor'), '["office"]'); // written after the sweep, by nothing real any more, but must still survive a second call
  dropLegacyRoomStorage(backing);
  assert.equal(store.get(floorStorageKey('late-floor')), '["office"]', 'the marker key skips every call after the first');
});

test('dropLegacyRoomStorage is a no-op without a storage that can enumerate keys (a minimal test mock, for instance)', () => {
  assert.doesNotThrow(() => dropLegacyRoomStorage(undefined));
  assert.doesNotThrow(() => dropLegacyRoomStorage({ getItem: () => null, setItem: () => undefined }));
});

test('constructing a building sweeps its own legacy storage once, and never rewrites a room list to it afterward', () => {
  const { store, backing } = legacyStorage({ [floorStorageKey('widget-service')]: JSON.stringify(['office', 'library', 'desks']) });
  const scene = new THREE.Scene();
  new BuildingLayout(scene, new Map(), { storage: backing, floor: 'widget-service' });
  assert.equal(store.has(floorStorageKey('widget-service')), false, 'the stale floor-scoped key is gone');
  assert.ok(store.has(ROOMS_DROPPED_KEY));
  assert.equal(store.has(floorStorageKey('widget-service')) || store.has(BUILDING_STORAGE_KEY), false, 'nothing re-seeds a legacy key after construction');
});

// --- Issue #126: war-room furniture routes agent activity, in-room first ---

test('AC1/AC2: researching and planning agents go to their own room\'s bookshelf and whiteboard', () => {
  const { layout, agent } = setup();
  layout.syncWorldRooms([missionRoom()]);
  const researching = layout.seatFor(agent('r', 'researching', { room: 'room-1' }), null)!;
  assert.match(researching.key, /^mission0_furniture_\w+_\d+$/);
  const planning = layout.seatFor(agent('p', 'planning', { room: 'room-1' }), null)!;
  assert.match(planning.key, /^mission0_furniture_\w+_\d+$/);
  // Two different pieces, not the same one shared by coincidence
  assert.notEqual(researching.key, planning.key);
});

// --- Issue #209: an idle mission agent relaxes in the main room's lounge, not its own war room ---

test('issue #209: an idle mission agent goes to the main room\'s lounge, not its own war room', () => {
  const { layout, agent } = setup();
  layout.syncWorldRooms([missionRoom()]);
  const idle = layout.seatFor(agent('i', 'idle', { room: 'room-1' }), null)!;
  assert.doesNotMatch(idle.key, /^mission0_/, 'not the war room');
  // Issue #260 step 7b item 6: the rect hall (its own coffee corner and sofas, `Office.ts`) is
  // gone — the hex Hub's own kitchen/play corner idle spots are the main room's idle capacity
  // now (`hubFurnitureSpots`'s own `idle` set, `HexRooms.ts`'s `buildHexOffice`).
  assert.match(idle.key, /^hex-hub-idle-/, 'a main-room idle station');
});

test('issue #209: an idle mission agent leaves its war room seat behind when it goes idle', () => {
  const { layout, agent, tick } = setup();
  layout.syncWorldRooms([missionRoom()]);
  const a = agent('a', 'researching', { room: 'room-1' });
  const working = layout.seatFor(a, null)!;
  assert.match(working.key, /^mission0_furniture_/, 'the war room\'s own bookshelf while researching');

  a.activity = 'idle';
  layout.seatFor(a, 'researching');
  const moves = tick(4000);
  const move = moves.find((m) => m.agentId === 'a');
  assert.ok(move, 'the agent moves once it goes idle');
  assert.doesNotMatch(move!.seat.key, /^mission0_/, 'off to the lounge, not left in the war room');
});

// Review: issue #209 took `idle` out of the room branch of `targetFor`, so a mission parent
// that only ever sat in its own war room (never once earning a `home` desk through the plain
// desk-work branch) can now leave `room:<id>` for `trip:idle` while a pod-anchored child's own
// pending `pod` assignment is still maturing. If the parent's own pending matures first, in the
// same `update()` pass, `podKeys` used to read `parent.home!` for its anchor once the parent was
// no longer in a room — `undefined` for a parent that never had one — and threw.
test('review: a pod subagent does not crash the layout when its parent goes idle out of a war room with no home desk', () => {
  const { layout, agent, tick } = setup();
  layout.syncWorldRooms([missionRoom()]);
  const parent = agent('p', 'debugging', { room: 'room-1' });
  layout.seatFor(parent, null);
  const child = agent('c', 'researching', { room: 'room-1', parentId: 'p', badges: ['librarian'] });
  layout.seatFor(child, null); // librarian + researching: trip:researching, bypasses pod

  parent.activity = 'idle';
  layout.seatFor(parent, 'debugging'); // pending: trip:idle (parent.home is still unset)
  child.activity = 'implementing';
  layout.seatFor(child, 'researching'); // pending: pod, read while parent.target still room:room-1

  assert.doesNotThrow(() => tick(4000), 'both pendings mature in the same tick');
});

test('AC5: a researching mission agent never goes to the library-knowledge shelves', () => {
  const { layout, agent } = setup();
  layout.syncWorldRooms([missionRoom()]);
  const seat = layout.seatFor(agent('r', 'researching', { room: 'room-1' }), null)!;
  assert.doesNotMatch(seat.key, /^hex-library-/, 'hex-library- is the building Library, not the war room');
});

// Issue #259 review round 2: there is no generic "room:<id>" ring any more (no meeting table,
// no standing ring — Gabriel's own round-6 base set is work furniture only). Once a war room's
// one piece of a kind is taken, the next agent of that same activity has nowhere room-specific
// left and falls through to the main room's lounge, the same graceful-degradation path
// `BuildingLayout.claimInRoom` already used for "no free spot of any kind".
test('AC4: once the room\'s one researching spot is taken, the next researcher falls through to the lounge, not a dedicated room', () => {
  const { layout, agent } = setup();
  layout.syncWorldRooms([missionRoom()]);
  layout.seatFor(agent('r1', 'researching', { room: 'room-1' }), null);
  const seat = layout.seatFor(agent('r2', 'researching', { room: 'room-1' }), null)!;
  assert.doesNotMatch(seat.key, /^mission0_/, 'no war-room ring left to fall back to');
  assert.doesNotMatch(seat.key, /^hex-library-/, 'not the library either');
});

// --- Issue #129/#259 review round 2: a desk-cap overflow has no standing ring any more — it
// falls through to the lounge, the same as any other kind of war-room overflow. ---

test('AC4 (#129): once a war room\'s desk cap is full, the next desk-like agent falls through to the lounge', () => {
  const { layout, agent, tick } = setup();
  layout.syncWorldRooms([missionRoom()]);
  for (let i = 0; i < 8; i++) layout.seatFor(agent(`d${i}`, 'implementing', { room: 'room-1' }), null);
  tick(0); // grows the desk grid to its cap
  for (let i = 0; i < 8; i++) layout.seatFor(agent(`d${i}`, 'implementing', { room: 'room-1' }), null);
  const overflow = layout.seatFor(agent('d8', 'implementing', { room: 'room-1' }), null)!;
  assert.doesNotMatch(overflow.key, /_furniture_/, 'no extra desk piece');
  assert.doesNotMatch(overflow.key, /^mission0_/, 'no war-room ring left to fall back to');
});

// --- Issue #126 review round 2: growth must actually reach seating, and an activity change
// inside the same room must re-run claimInRoom, through the real BuildingLayout ---

test('a desk-like agent moves onto a grown desk once one exists, not left in the lounge', () => {
  const { layout, agent, tick } = setup();
  layout.syncWorldRooms([missionRoom()]);
  // Issue #209: the base work set's own desk is there from the start, so the first
  // implementing agent claims it immediately; growth is only visible from the second on.
  const a = agent('a', 'implementing', { room: 'room-1' });
  const firstA = layout.seatFor(a, null)!;
  assert.match(firstA.key, /mission0_furniture_implementing_\d+/, 'the base work set\'s own desk, already there');

  const b = agent('b', 'implementing', { room: 'room-1' });
  const firstB = layout.seatFor(b, null)!;
  assert.doesNotMatch(firstB.key, /^mission0_/, 'no second desk exists yet, and no war-room ring left: the lounge');

  tick(0); // grows a second desk, now that two implementing agents are counted in the room
  // Same activity, same room target string: only an activity-aware re-check (not the
  // brand-new-agent path above) can notice the freshly grown desk is now free.
  layout.seatFor(b, 'implementing');
  const moves = tick(4000); // past the dwell time
  const move = moves.find((m) => m.agentId === 'b');
  assert.ok(move, 'agent b is moved once the dwell time passes');
  assert.match(move!.seat.key, /mission0_furniture_/, 'onto the grown desk, not left in the lounge');
});

// --- Issue #126 review round 3: growing one furniture station must never carry its
// `occupied` flag onto a different one, just because growth shifted the array position
// (the desk grid's slots sit first in the plan, so adding one shifts every must-have
// after it by one index) ---

test('growing a desk never makes the whiteboard read as falsely taken (a researcher keeps the bookshelf, a planner still gets the real whiteboard)', () => {
  const { layout, agent, tick } = setup();
  layout.syncWorldRooms([missionRoom()]);
  const researcher = layout.seatFor(agent('r', 'researching', { room: 'room-1' }), null)!;
  assert.match(researcher.key, /^mission0_furniture_researching_\d+$/, 'the bookshelf, a must-have, before any growth');

  // An implementing agent grows the desk grid past the base set's own desk, shifting the
  // whiteboard and bookshelf one index later in `furnishWarRoom`'s plan array.
  const implementer = agent('i', 'implementing', { room: 'room-1' });
  layout.seatFor(implementer, null);
  tick(0);
  layout.seatFor(implementer, 'implementing');
  tick(4000);

  const planner = layout.seatFor(agent('p', 'planning', { room: 'room-1' }), null)!;
  assert.match(planner.key, /^mission0_furniture_planning_\d+$/, 'the real whiteboard, not the generic ring');
});

test('growing a debug station never makes the bookshelf read as falsely taken', () => {
  const { layout, agent, tick } = setup();
  layout.syncWorldRooms([missionRoom()]);

  const debugger_ = agent('b', 'debugging', { room: 'room-1' });
  layout.seatFor(debugger_, null);
  tick(0);
  layout.seatFor(debugger_, 'debugging');
  tick(4000);

  const researcher = layout.seatFor(agent('r', 'researching', { room: 'room-1' }), null)!;
  assert.match(researcher.key, /^mission0_furniture_researching_\d+$/, 'the real bookshelf, not the generic ring');
});

test('an activity change inside the same war room re-runs claimInRoom, not swallowed as "same target"', () => {
  const { layout, agent, tick } = setup();
  layout.syncWorldRooms([missionRoom()]);
  const a = agent('a', 'researching', { room: 'room-1' });
  const first = layout.seatFor(a, null)!;
  assert.match(first.key, /^mission0_furniture_\w+_\d+$/, 'the room\'s own bookshelf (a must-have, no growth needed)');

  a.activity = 'planning';
  const immediate = layout.seatFor(a, 'researching');
  assert.equal(immediate, null, 'a mid-room activity change still waits for the dwell time, like any other move');
  const moves = tick(4000);
  const move = moves.find((m) => m.agentId === 'a');
  assert.ok(move, 'the agent moves once the dwell time passes');
  assert.notEqual(move!.seat.key, first.key, 'off the bookshelf, not stuck there forever');
});

test('a waiting agent still goes to the user office before its war room', () => {
  const { layout, agent } = setup();
  layout.syncWorldRooms([missionRoom()]);
  const seat = layout.seatFor(agent('w', 'meeting', { room: 'room-1', attention: 'waiting' }), null)!;
  assert.match(seat.key, /^hex-office-queue-/);
});

test('a war room\'s furniture grows with the agents actually seated in it (issue #125)', () => {
  const { layout, agent, scene, tick } = setup();
  layout.syncWorldRooms([missionRoom()]);
  const warRoom = scene.getObjectByName('mission-room-0')!;
  const pieceCount = (name: string) => {
    let n = 0;
    warRoom.traverse((o) => { if (o.userData.piece === name) n++; });
    return n;
  };
  // Issue #209: the base work set is there before anyone works here.
  assert.equal(pieceCount('desk'), 1, 'the base work set\'s one workstation');
  assert.equal(pieceCount('debugStation'), 1, 'the base work set\'s one debug station');

  layout.seatFor(agent('a', 'implementing', { room: 'room-1' }), null);
  layout.seatFor(agent('b', 'implementing', { room: 'room-1' }), null);
  layout.seatFor(agent('c', 'debugging', { room: 'room-1' }), null);
  tick(0);
  assert.equal(pieceCount('desk'), 2);
  assert.equal(pieceCount('debugStation'), 1);

  // The debugger leaves; the furniture stays at its peak
  layout.seatFor(agent('c', 'idle', { room: 'room-1' }), 'debugging');
  tick(0);
  assert.equal(pieceCount('desk'), 2);
  assert.equal(pieceCount('debugStation'), 1);
});

// --- Issue #129 review round 2: a war room's peak counts persist, so a reload while the
// room happens to be empty does not reset the never-shrinks rule to zero ---

test('a war room\'s peak desk and debug counts survive a reload, even while the room is empty', () => {
  const storage = new Map<string, string>();
  const first = setup(storage);
  first.layout.syncWorldRooms([missionRoom()]);
  first.layout.seatFor(first.agent('a', 'implementing', { room: 'room-1' }), null);
  first.layout.seatFor(first.agent('b', 'debugging', { room: 'room-1' }), null);
  first.tick(0);
  const pieceCount = (scene: THREE.Scene, name: string) => {
    let n = 0;
    scene.getObjectByName('mission-room-0')!.traverse((o) => { if (o.userData.piece === name) n++; });
    return n;
  };
  assert.equal(pieceCount(first.scene, 'desk'), 1);
  assert.equal(pieceCount(first.scene, 'debugStation'), 1);

  // A reload: a fresh BuildingLayout and scene, the same storage, the room reported with no
  // agents yet (the mission server itself tracks who is where, not a peak; this layout's own
  // in-memory peak is what is at risk here).
  const second = setup(storage);
  second.layout.syncWorldRooms([missionRoom()]);
  assert.equal(pieceCount(second.scene, 'desk'), 1, 'the peak survived the reload, not reset to zero');
  assert.equal(pieceCount(second.scene, 'debugStation'), 1);
});

// --- roomView (issue #89, #room=) ---

test('roomView("office") frames the user\'s office — issue #260 steps 2+3: the rect office is gone, "office" is now a "hex-office" alias', () => {
  const { layout } = setup();
  const view = layout.roomView('office')!;
  assert.ok(view, 'office exists from the start');
  assert.deepEqual(view, layout.roomView('hex-office'));
  assert.ok(view.bounds.max.y > view.bounds.min.y, 'has floor-to-wall height, not a flat box');
});

test('roomView is case-insensitive and trims whitespace', () => {
  const { layout } = setup();
  assert.deepEqual(layout.roomView('OFFICE'), layout.roomView('office'));
  assert.deepEqual(layout.roomView('  library  '), layout.roomView('library'));
});

test('roomView returns null for a kind that is not yet open and for any unknown name', () => {
  const { layout } = setup();
  assert.equal(layout.roomView('lab'), null, 'no test lab has been rented yet');
  assert.equal(layout.roomView('not-a-room'), null);
  assert.equal(layout.roomView(''), null);
});

// --- roomView: the hex Hub and Office (issue #218 steps 2/3 review, #room=hub/#room=hex-office) ---

test('roomView("hub") and roomView("hex-office") frame the new hex rooms, two different rooms', () => {
  const { layout } = setup();
  const hub = layout.roomView('hub')!;
  const hexOffice = layout.roomView('hex-office')!;
  assert.ok(hub, 'the hub always exists');
  assert.ok(hexOffice, 'the hex office always exists');
  assert.ok(hub.bounds.max.y > hub.bounds.min.y, 'has floor-to-wall height');
  assert.ok(hexOffice.bounds.max.y > hexOffice.bounds.min.y, 'has floor-to-wall height');
  assert.notDeepEqual(hub.bounds, hexOffice.bounds);
});

test('roomView("hub")/("hex-office") is case-insensitive and trims whitespace, like every other roomView name', () => {
  const { layout } = setup();
  assert.deepEqual(layout.roomView('HUB'), layout.roomView('hub'));
  assert.deepEqual(layout.roomView('  Hex-Office  '), layout.roomView('hex-office'));
});

test('roomView matches a mission room by its slugified title or its public id — through the real projectWorld projection (review fix 2)', () => {
  const { layout } = setup();
  assert.equal(layout.roomView('media-plan-q1'), null, 'not open yet');

  // The real server projection: the client only ever sees the hashed id and the display
  // title, never the raw `mission:<slug>` key this started from.
  const publicId = createFakePublicId();
  const projected = projectWorld(
    [{ rooms: [{ key: 'mission:media-plan-q1', kind: 'mission', title: 'Media Plan Q1', state: 'open', walls: {} }] }],
    ['missions'],
    publicId,
  ).rooms[0]!;
  assert.notEqual(projected.id, 'mission:media-plan-q1', 'the id a client sees is hashed, not the raw key');
  assert.equal(projected.title, 'Media Plan Q1');

  layout.syncWorldRooms([{ id: projected.id, kind: 'mission', title: projected.title, state: 'open', sleepers: [], walls: {} }]);

  assert.equal(layout.roomView('mission:media-plan-q1'), null, 'the raw server-side key never works on the client');
  const byTitle = layout.roomView('media-plan-q1')!;
  assert.ok(byTitle, 'matches by the slugified title instead');
  const byUppercaseTitle = layout.roomView('Media-Plan-Q1')!;
  assert.deepEqual(byUppercaseTitle, byTitle, 'case-insensitive, like every other roomView name');
  const byId = layout.roomView(projected.id)!;
  assert.deepEqual(byId, byTitle, 'the exact public id also works, for a reviewer who copies it from /api/world');

  const missionRect = hexRoomRect(testHexWarRoom(0));
  assert.deepEqual([byTitle.bounds.min.x, byTitle.bounds.max.x, byTitle.bounds.min.z, byTitle.bounds.max.z],
    [missionRect.minX, missionRect.maxX, missionRect.minZ, missionRect.maxZ]);
});

test('roomView picks none when two mission rooms slugify to the same title; the exact public id still works (review fix round 2)', () => {
  const { layout } = setup();
  const publicId = createFakePublicId();
  const projected = projectWorld(
    [{ rooms: [
      { key: 'mission:media-plan', kind: 'mission', title: 'Media Plan', state: 'open', walls: {} },
      { key: 'mission:media/plan', kind: 'mission', title: 'Media/Plan', state: 'open', walls: {} },
    ] }],
    ['missions'],
    publicId,
  ).rooms;
  assert.notEqual(projected[0]!.id, projected[1]!.id, 'two distinct rooms, two distinct ids');

  layout.syncWorldRooms(projected.map((room) => ({ id: room.id, kind: 'mission' as const, title: room.title, state: 'open' as const, sleepers: [], walls: {} })));

  assert.equal(layout.roomView('media-plan'), null, 'ambiguous by title: picks none, not whichever came first');
  assert.ok(layout.roomView(projected[0]!.id), 'the exact public id still resolves its own room');
  assert.ok(layout.roomView(projected[1]!.id), 'and the other room by its own id');
  assert.notDeepEqual(layout.roomView(projected[0]!.id), layout.roomView(projected[1]!.id));
});

test('roomView\'s first-person standing point sits inside the hex office, facing further into it', () => {
  const { layout } = setup();
  const view = layout.roomView('office')!;
  assert.ok(view.standing.position.x > view.bounds.min.x && view.standing.position.x < view.bounds.max.x, 'inside the room on x');
  assert.ok(view.standing.position.z > view.bounds.min.z && view.standing.position.z < view.bounds.max.z, 'inside the room on z');
  assert.ok(view.standing.position.y > 0, 'a standing eye height, not on the floor');
  const facing = view.standing.lookAt.clone().sub(view.standing.position);
  assert.ok(facing.lengthSq() > 0, 'looks somewhere other than straight down at its own feet');
});

// --- deskView and roomAt (issue #161, #175) ---

// Issue #260 steps 2+3: the hex desk camera's own pure geometry (position, lookAt toward the
// queue, FOV, sightlines) is covered in depth by `tests/hex-desk-geometry.test.ts`; this is
// only the integration check that `BuildingLayout.deskView` actually wires to it.
test('deskView sits inside the hex office, at a sitting eye height, looking somewhere other than straight down', () => {
  const { layout } = setup();
  const view = layout.deskView()!;
  const officeView = layout.roomView('office')!;
  assert.ok(view.position.x > officeView.bounds.min.x && view.position.x < officeView.bounds.max.x, 'inside the office on x');
  assert.ok(view.position.z > officeView.bounds.min.z && view.position.z < officeView.bounds.max.z, 'inside the office on z');
  assert.ok(view.position.y > 0, 'a sitting eye height, not on the floor');
  assert.ok(view.position.y < officeView.standing.position.y, 'the desk view sits lower than the standing queue view');
  assert.notDeepEqual(view.lookAt, view.position, 'looks somewhere other than straight down at its own feet');
});

// --- setDeskChairVisible (issue #243): the desk-view camera sits close enough to the user's
// own chair that it otherwise fills the bottom of the frame ---

function officeChair(scene: THREE.Scene): THREE.Object3D {
  const office = scene.getObjectByName('hex-office');
  const chair = office?.getObjectByName('desk-chair');
  if (!chair) throw new Error('no desk-chair found under hex-office');
  return chair;
}

test('setDeskChairVisible(false) hides the office chair, setDeskChairVisible(true) shows it again', () => {
  const { layout, scene } = setup();
  const chair = officeChair(scene);
  assert.equal(chair.visible, true, 'visible by default, the old behavior (isometric and first person)');

  layout.setDeskChairVisible(false);
  assert.equal(chair.visible, false);

  layout.setDeskChairVisible(true);
  assert.equal(chair.visible, true);
});

test('setDeskChairVisible never touches any other desk (a war room desk, for example) — only the office\'s own chair', () => {
  const { layout, scene } = setup();
  layout.syncWorldRooms([{ id: 'm0', kind: 'mission', title: 'Media Plan', state: 'open', walls: {} }]);
  layout.setDeskChairVisible(false);
  const missionRoom = scene.children.find((child) => /^mission-room-\d+$/.test(child.name));
  assert.ok(missionRoom, 'a mission (war room) is in the scene');
  let missionChairs = 0;
  missionRoom!.traverse((object) => { if (object.name === 'desk-chair') missionChairs++; });
  assert.ok(missionChairs > 0, 'a war room desk has its own chair(s) too');
  missionRoom!.traverse((object) => { if (object.name === 'desk-chair') assert.equal(object.visible, true, 'a war room chair is never hidden by the office-only toggle'); });
});

// --- deskTalkSpot and isQueued (issue #162) ---

test('deskTalkSpot sits inside the office, standing, facing the desk camera', () => {
  const { layout } = setup();
  const spot = layout.deskTalkSpot()!;
  const view = layout.deskView()!;
  const officeView = layout.roomView('office')!;
  assert.ok(spot.position.x > officeView.bounds.min.x && spot.position.x < officeView.bounds.max.x, 'inside the office on x');
  assert.ok(spot.position.z > officeView.bounds.min.z && spot.position.z < officeView.bounds.max.z, 'inside the office on z');
  // Review: a standing Seat's position is the figure's root, not its eye point (every other
  // standing seat here — queueSpots, the home desks — sits at floor level); a figure placed at
  // eye height instead would float above the floor.
  assert.equal(spot.position.y, 0, 'the figure\'s root sits on the floor, not at eye height');
  assert.equal(spot.posture, 'standing');
  assert.deepEqual(spot.lookAt.toArray(), view.position.toArray(), 'faces back toward the desk camera, the same point it sits at');
});

test('isQueued is true only for an agent actually waiting in the queue', () => {
  const { layout, agent } = setup();
  layout.seatFor(agent('q', 'idle', { attention: 'waiting', waitMinutes: 5 }), null);
  layout.seatFor(agent('d', 'implementing'), null);
  assert.equal(layout.isQueued('q'), true);
  assert.equal(layout.isQueued('d'), false);
  assert.equal(layout.isQueued('nobody'), false, 'an unknown agent id is never queued');
});

test('roomAt finds the office by a point inside it, and returns null between rooms', () => {
  const { layout } = setup();
  const officeView = layout.roomView('office')!;
  const center = officeView.bounds.getCenter(new THREE.Vector3());
  const hit = layout.roomAt(center.x, center.z)!;
  assert.ok(hit, 'a point inside the office finds a room');
  assert.deepEqual(hit.bounds, officeView.bounds);

  assert.equal(layout.roomAt(1000, 1000), null, 'far outside every room');
});

test('roomAt reports the library room\'s own kind (issue #239: so a caller can special-case the library door without knowing building internals)', () => {
  const { layout } = setup();
  // Issue #258: the Library is the hex room behind the hex Office now, not rect room index 1.
  // Issue #260 steps 2+3: only the library's `kind` is load-bearing (`ViewController`'s scene
  // swap, `HexRooms.ts`'s own `roomAt`); the office's hex room never carried one either way.
  const libraryCenter = layout.roomView('library')!.bounds.getCenter(new THREE.Vector3());
  assert.equal(layout.roomAt(libraryCenter.x, libraryCenter.z)?.kind, 'library');
});

test('roomAt finds a mission room by its own rect, not just building rooms', () => {
  const { layout } = setup();
  layout.syncWorldRooms([{ id: 'm0', kind: 'mission', title: 'Media Plan', state: 'open', walls: {} }]);
  const rect = hexRoomRect(testHexWarRoom(0));
  const centerX = (rect.minX + rect.maxX) / 2;
  const centerZ = (rect.minZ + rect.maxZ) / 2;
  const hit = layout.roomAt(centerX, centerZ)!;
  assert.ok(hit, 'a point inside the mission room rect finds it');
  assert.deepEqual([hit.bounds.min.x, hit.bounds.max.x, hit.bounds.min.z, hit.bounds.max.z], [rect.minX, rect.maxX, rect.minZ, rect.maxZ]);
});

// --- roomAt over the hex structure (issue #249: a double-click in isometric over the Hub or
// Office did nothing — roomAt only ever scanned the rect rooms above) ---

test('roomAt finds the hex Hub and Office too, not just the rect rooms', () => {
  const { layout } = setup();
  const hubCenter = layout.roomView('hub')!.bounds.getCenter(new THREE.Vector3());
  const hub = layout.roomAt(hubCenter.x, hubCenter.z);
  assert.ok(hub, 'a point inside the hub finds it');
  assert.deepEqual(hub, layout.roomView('hub'));

  const officeCenter = layout.roomView('hex-office')!.bounds.getCenter(new THREE.Vector3());
  const hexOffice = layout.roomAt(officeCenter.x, officeCenter.z);
  assert.ok(hexOffice, 'a point inside the hex office finds it');
  assert.deepEqual(hexOffice, layout.roomView('hex-office'));
});

test('roomAt between the hub and the hex office (on the walkway, not inside either hex) still returns null', () => {
  const { layout } = setup();
  const hubCenter = layout.roomView('hub')!.bounds.getCenter(new THREE.Vector3());
  const officeCenter = layout.roomView('hex-office')!.bounds.getCenter(new THREE.Vector3());
  const midpoint = hubCenter.clone().add(officeCenter).multiplyScalar(0.5);
  assert.equal(layout.roomAt(midpoint.x, midpoint.z), null, 'between the two hex rooms is not inside either');
});

// --- Library and librarians ---

test('the Librarian persona badge reaches the Library room before the hall shelves (issue #128)', () => {
  const { layout, agent } = setup();
  const seat = layout.seatFor(agent('r', 'researching', { badges: ['librarian'] }), null)!;
  assert.match(seat.key, /^hex-library-/);
});

test('a librarian walks to the Library to research and back to its agent with what it found', () => {
  const { layout, agent, tick } = setup();
  const desk = layout.seatFor(agent('parent', 'implementing'), null)!;
  const fetching = layout.seatFor(agent('lib', 'researching', { parentId: 'parent', badges: ['librarian'] }), null)!;
  assert.match(fetching.key, /^hex-library-/);

  layout.seatFor(agent('lib', 'writing_docs', { parentId: 'parent', badges: ['librarian'] }), 'researching');
  const back = tick(4500).find((m) => m.agentId === 'lib')!;
  assert.match(back.seat.key, /_pod\d$/);
  assert.ok(back.seat.position.distanceTo(desk.position) < 2);
});

test('an old-style role tag, with no Librarian persona badge, no longer reaches the Library (issue #128, Prospero\'s review)', () => {
  const { layout, agent } = setup();
  const seat = layout.seatFor(agent('r', 'researching', { role: 'librarian' }), null)!;
  assert.doesNotMatch(seat.key, /^hex-library-/, 'a name or role tag alone is not the persona signal');
});

test('a main session with no Librarian badge and no war room keeps its own desk for a research trip, not the Library (issue #128 AC2)', () => {
  const { layout, agent } = setup();
  const seat = layout.seatFor(agent('r', 'researching'), null)!;
  assert.doesNotMatch(seat.key, /^hex-library-/);
  assert.doesNotMatch(seat.key, /researching/, 'it never visits any researching station, hall shelves included');
  assert.match(seat.key, /^hex-hub-desk-/);
});

test('a main session with a war room keeps a non-librarian research trip inside that room, not the Library (issue #128 AC3)', () => {
  const { layout, agent } = setup();
  layout.syncWorldRooms([missionRoom()]);
  const seat = layout.seatFor(agent('r', 'researching', { room: 'room-1' }), null)!;
  // Issue #126, after this AC was written: a researching agent in a war room prefers that
  // room's own bookshelf (`mission0_furniture_*`) over its generic ring (`mission0_seat_*`).
  // Either one satisfies this AC's real point, inside the war room and never the Library.
  assert.match(seat.key, /^mission0_(seat|furniture)_/, 'inside its own war room');
  assert.doesNotMatch(seat.key, /^hex-library-/, 'never the Library');
});

test('an ordinary subagent that researches stays at its parent desk', () => {
  const { layout, agent } = setup();
  layout.seatFor(agent('parent', 'implementing'), null);
  assert.match(layout.seatFor(agent('helper', 'researching', { parentId: 'parent' }), null)!.key, /_pod\d$/);
});

// --- Issue #164 point 3: a pod subagent sits, it does not stand with no explanation ---

test('a pod subagent sits on its own stool, whatever its activity: standing was the thing that read as "something is wrong"', () => {
  const { layout, agent } = setup();
  layout.seatFor(agent('parent', 'implementing'), null);
  const idle = layout.seatFor(agent('helper', 'idle', { parentId: 'parent' }), null)!;
  assert.match(idle.key, /_pod\d$/);
  assert.equal(idle.posture, 'seated', 'an idle pod subagent sits, same as a sofa idle seat');

  const busy = layout.seatFor(agent('helper2', 'implementing', { parentId: 'parent' }), null)!;
  assert.match(busy.key, /_pod\d$/);
  assert.equal(busy.posture, 'seated', 'a working pod subagent sits too: no pod posture depends on activity');
});

test('every pod slot around one parent gets its own stool mesh, built once, never duplicated for a second subagent', () => {
  const { layout, agent, scene } = setup();
  const desk = layout.seatFor(agent('parent', 'implementing'), null)!;
  const first = layout.seatFor(agent('helper', 'idle', { parentId: 'parent' }), null)!;

  const countStools = () => {
    let stools = 0;
    scene.traverse((object) => { if ((object.userData.staticBatch as { zone?: string } | undefined)?.zone === 'pods') stools++; });
    return stools;
  };
  // podKeys() builds the parent's whole pod pool (6 slots) up front, so one subagent
  // already brings all 6 stools into the scene, not just the one it claims.
  const afterFirst = countStools();
  assert.equal(afterFirst, 6, 'the parent\'s whole pod pool, 6 stools, is built on the first subagent');

  // A seat that close to the desk is the pod's own stool, not the desk's own chair (createDesk
  // already places one at its own fixed offset); the pod stool sits within its own small radius.
  assert.ok(first.position.distanceTo(desk.position) < 2, 'the pod sits close to the parent desk');

  // A second subagent at the same parent reuses the same pool: no new stool gets built.
  layout.seatFor(agent('helper2', 'idle', { parentId: 'parent' }), null);
  assert.equal(countStools(), afterFirst, 'a second pod subagent reuses the existing pool, no stool rebuilt');
});

test('many pod stools across many parents still merge into a bounded draw-call cost (one zone, shared colors)', async () => {
  const { layout, agent, scene } = setup();
  for (let p = 0; p < 10; p++) {
    layout.seatFor(agent(`parent${p}`, 'implementing'), null);
    for (let h = 0; h < 6; h++) layout.seatFor(agent(`helper${p}_${h}`, 'idle', { parentId: `parent${p}` }), null);
  }
  const { StaticBatch } = await import('../src/scene/StaticMerge.js');
  scene.updateMatrixWorld();
  const batch = new StaticBatch(scene);
  batch.update();
  const podMeshes = batch.mergedMeshes.filter((mesh) => mesh.parent?.name === 'static-batch-pods');
  // The stool reuses 2 cached colors (seat, dark); the 'pods' zone merges every stool
  // into one merged mesh per material, however many pods exist (60 here).
  assert.ok(podMeshes.length > 0 && podMeshes.length <= 2, `expected 1-2 merged meshes for the whole pods zone, got ${podMeshes.length}`);
});

test('a non-librarian subagent whose parent has no seat yet never reaches the Library, even on this exact timing (issue #128 review)', () => {
  // A real race: a subagent is polled in the same cycle as its freshly spawned, not-yet-seated
  // parent. The persona check and the pod check both fall through; the generic research
  // routing must still never land on the Library's own shelves.
  const { layout, agent } = setup();
  const seat = layout.seatFor(agent('helper', 'researching', { parentId: 'parent' }), null)!;
  assert.doesNotMatch(seat.key, /^hex-library-/, 'never the Library, even with an unseated parent');
  assert.doesNotMatch(seat.key, /_pod\d$/, 'there is no parent seat yet to anchor a pod spot to');
});

test('a librarian subagent still reaches the Library even though its parent already has a desk (the badge wins over the pod rule)', () => {
  const { layout, agent } = setup();
  layout.seatFor(agent('parent', 'implementing'), null);
  const seat = layout.seatFor(agent('lib', 'researching', { parentId: 'parent', badges: ['librarian'] }), null)!;
  assert.match(seat.key, /^hex-library-/);
});

// --- Issue #120: the library wing moves to the south-east ---

test('the library (the second room the building ever rents) sits at the south-east slot, not the north-east', () => {
  // slotFor(1) is where the second rented room goes; the building rents the Library second,
  // right after the office. South of the hall is positive z (the front, where the meeting
  // table and coffee area sit); north is negative z (the back wall, the whiteboards).
  const slot = slotFor(1);
  assert.ok(slot.rect.minZ > 0, `slot 1 is south (minZ=${slot.rect.minZ}), not north`);
  // AC2: the corridor branch toward slot 1 (the hall's own door) leads straight to the
  // Library's entrance, the same way every ring-0 room's door already matches its slot
  // (rebuildHallWalls derives every door from slotFor(room.index)); this geometric
  // identity is what guarantees it, not a separate corridor structure (none exists yet).
  assert.deepEqual(slot.door, { side: 'west', at: 9.5 });
});

// --- Workspace grouping in the shared desk pool (#138: per-workspace desk rooms retired) ---

const inWorkspace = (label: string) => ({ group: { id: `g-${label}`, label } });

test('tagged sessions sit at the hub desks with everyone else; no desk room is rented for them', () => {
  const { layout, agent, scene } = setup();
  const a1 = layout.seatFor(agent('a1', 'implementing', inWorkspace('Alpha')), null)!;
  const b1 = layout.seatFor(agent('b1', 'implementing', inWorkspace('Beta')), null)!;
  const loner = layout.seatFor(agent('n', 'implementing'), null)!;

  assert.match(a1.key, /^hex-hub-desk-/);
  assert.match(b1.key, /^hex-hub-desk-/);
  assert.match(loner.key, /^hex-hub-desk-/);
  const labels = scene.children.flatMap((c) => c.children).filter((c) => c.userData.roomLabel !== undefined).map((c) => c.userData.roomLabel);
  assert.ok(!labels.some((label) => label.startsWith('Desks ·')), 'no per-workspace room label');
});

test('sessions of one workspace get neighboring desks', () => {
  const { layout, agent } = setup();
  const a1 = layout.seatFor(agent('a1', 'implementing', inWorkspace('Alpha')), null)!;
  const a2 = layout.seatFor(agent('a2', 'implementing', inWorkspace('Alpha')), null)!;
  const b1 = layout.seatFor(agent('b1', 'implementing', inWorkspace('Beta')), null)!;

  assert.notEqual(a1.key, a2.key);
  assert.notEqual(b1.key, a1.key);
  assert.notEqual(b1.key, a2.key);
  assert.ok(a2.position.distanceTo(a1.position) < b1.position.distanceTo(a1.position), "Alpha's own next session sits closer to it than Beta's desk does");
});

// Issue #260 step 7b item 6: the hex Hub's own 8 spare desks (`hubFurnitureSpots`) cluster in
// 2 groups of 4, one at each of two opposite Hub corners, about 9 m apart across the gap —
// `hex-hub-desk-0..3` at one corner, `hex-hub-desk-4..7` at the other, each group's own 4 desks
// a bit over 1 m apart in a line. `pickDesk`'s key order (insertion order, 0 through 7) runs
// straight across both corners, so a free desk back at the FAR corner (released after it filled
// up) can carry a lower key than a free desk right next to the workspace's own existing one at
// the NEAR corner — the exact "key suffix misleads, real position wins" shape the old rect
// hall's own two-rows-of-four desk grid demonstrated (#138), reproduced here by filling every
// desk once, then releasing three at the far corner so they are free again, but with a far
// lower key than the two near the workspace's own desk.
test('"next to" is physical distance, not a key suffix: a desk at the near corner beats one released back at the far corner (#138 fix)', () => {
  const { layout, agent } = setup();
  for (let i = 0; i < 5; i++) layout.seatFor(agent(`n${i}`, 'implementing'), null); // hex-hub-desk-0..4
  const home = layout.seatFor(agent('a', 'implementing', inWorkspace('Alpha')), null)!; // hex-hub-desk-5
  assert.equal(home.key, 'hex-hub-desk-5');
  layout.seatFor(agent('n6', 'implementing'), null); // hex-hub-desk-6
  layout.seatFor(agent('n7', 'implementing'), null); // hex-hub-desk-7

  // Release the 3 lowest-keyed desks (0, 1 at the far corner from Alpha's own desk 5; 6 at the
  // near corner, right next to it) — free, in key order, is [0, 1, 6].
  layout.release('n0');
  layout.release('n1');
  layout.release('n6');

  const a2 = layout.seatFor(agent('a2', 'implementing', inWorkspace('Alpha')), null)!;
  assert.equal(a2.key, 'hex-hub-desk-6', 'the true nearest free desk (the near corner), not hex-hub-desk-0 (lowest key, the far corner)');
});

test('a session whose workspace becomes known later keeps its desk; home is for life', () => {
  const { layout, agent } = setup();
  const first = layout.seatFor(agent('late', 'implementing'), null)!;
  assert.match(first.key, /^hex-hub-desk-/);
  assert.equal(layout.seatFor(agent('late', 'implementing', inWorkspace('Gamma')), 'implementing'), null, 'no move');
});

// --- Issue #144: a small missions board near the mission corridor ---

test('the missions board exists from the start, empty, and updates as missions arrive and close', () => {
  const { layout, scene, tick } = setup();
  const board = scene.getObjectByName('missions-board');
  assert.ok(board, 'the board is mounted even with no missions yet');

  layout.syncWorldRooms([{
    id: 'm-1', kind: 'mission', title: 'Office roadmap', state: 'open',
    createdAt: '2026-11-20T00:00:00Z',
    walls: { statement: 'x', docs: [], issues: [], kanban: [] },
  }]);
  // The board's own timer tick (not tied to the next world poll) must not throw
  tick(1500);
  tick(1500);

  layout.syncWorldRooms([{
    id: 'm-1', kind: 'mission', title: 'Office roadmap', state: 'locked',
    createdAt: '2026-11-20T00:00:00Z', closedAt: '2026-11-20T00:00:03Z',
    walls: { statement: 'x', docs: [], issues: [], kanban: [] },
  }]);
  tick(1500);
  // Still mounted: a closed mission does not remove the board or itself from it
  assert.ok(scene.getObjectByName('missions-board'));
});

// --- Issue #261 review: overflow must never stack two agents on one station ---

test('60 agents each land on a unique station: idle overflow never hands out an already-occupied spot (review-261 finding 1)', () => {
  const { layout, agent } = setup();
  const positions = new Set<string>();
  for (let i = 0; i < 60; i++) {
    const seat = layout.seatFor(agent(`agent-${i}`, 'implementing'), null)!;
    const key = `${seat.position.x.toFixed(2)},${seat.position.z.toFixed(2)}`;
    assert.ok(!positions.has(key), `agent ${i} landed on an already-claimed position ${key} (${seat.key})`);
    positions.add(key);
  }
  assert.equal(positions.size, 60, 'every one of 60 agents gets its own seat, none stacked');
});

test('overflow idle stations beyond the Hub\'s fixed capacity are new, distinct stations, not the same key reused', () => {
  const { layout, agent } = setup();
  const keys = new Set<string>();
  // The hall (8) and the Hub (4) together carry 12 fixed idle stations; well past that.
  for (let i = 0; i < 20; i++) keys.add(layout.seatFor(agent(`idle-${i}`, 'idle'), null)!.key);
  assert.equal(keys.size, 20, 'every idle agent claims a distinct station key');
});

test('research overflow never rents the old rectangular library room again (review-261 finding 2)', () => {
  const { layout, agent, scene } = setup();
  // 2 hex-library shelves + 2 hall shelves = 4 fixed researching stations; push well past that.
  for (let i = 0; i < 12; i++) {
    layout.seatFor(agent(`librarian-${i}`, 'researching', { badges: ['librarian'] }), null);
  }
  for (const record of scene.children) {
    assert.doesNotMatch(record.name ?? '', /-library$/, `a rect library room was built: ${record.name}`);
  }
  assert.equal(scene.getObjectByName('room-1-library'), undefined, 'the rect library room must never build');
});

test('research overflow past the fixed shelves still lands every librarian on its own spot, inside the Library', () => {
  const { layout, agent } = setup();
  const keys = new Set<string>();
  // The first 4 (2 hex-library shelves + 2 hall shelves) claim the fixed stations; every
  // one past that must still be a unique, real spot — and once those 4 are gone, the
  // Library's own overflow spiral, never a rented room.
  for (let i = 0; i < 12; i++) {
    const seat = layout.seatFor(agent(`librarian-${i}`, 'researching', { badges: ['librarian'] }), null)!;
    if (i >= 4) assert.match(seat.key, /^hex-library-/, 'overflow still lands inside the Library, never a rented room');
    keys.add(seat.key);
  }
  assert.equal(keys.size, 12, 'every librarian gets its own distinct spot, none stacked');
});

// --- Issue #261 review finding 3: a wing rebuild must never un-occupy a still-held station ---

test('a station still held by an agent stays occupied across a wing rebuild (review-261 finding 3)', () => {
  const { layout, agent } = setup();
  // The hall's own 8 idle stations (coffee/sofa) come before the hex Hub's own 4
  // (`hex-hub-idle-*`) in claim order; fill them first so the next idle agent is
  // forced onto a hub station, the one kind `addHexHubStations` re-registers on
  // every wing rebuild.
  for (let i = 0; i < 8; i++) layout.seatFor(agent(`filler-${i}`, 'idle'), null);
  const idleAgent = layout.seatFor(agent('idle-holder', 'idle'), null)!;
  assert.match(idleAgent.key, /^hex-hub-idle-/, 'test setup: the holder must land on a hub idle station');

  // Growing a new mission wing tears down and rebuilds the hex Hub/Library group
  // (`rebuildHexOffice`), which used to re-register every hub/library station from
  // scratch and silently reset `occupied` to false on every one of them.
  layout.syncWorldRooms([{
    id: 'm-1', kind: 'mission', title: 'Mission 1', state: 'open',
    walls: { statement: 'x', docs: [], issues: [], kanban: [] },
  }]);

  // A second agent asking for the same idle station type must never be handed the
  // key `idle-holder` is still standing at.
  const secondIdle = layout.seatFor(agent('idle-holder-2', 'idle'), null)!;
  assert.notEqual(secondIdle.key, idleAgent.key, 'the first idle agent\'s station must still read occupied after the rebuild');
});
