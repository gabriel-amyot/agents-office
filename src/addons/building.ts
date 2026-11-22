import { registerLayout } from '../layout/registry.js';
import { registerExtension } from '../extensions.js';
import { BuildingLayout } from './building/BuildingLayout.js';
import { loadPortrait } from './building/portrait.js';
import { ALL_FLOORS } from '../floors/FloorRegistry.js';
import { focusedFloor } from '../floors/floorState.js';
import { mountHexDebugOverlay } from './building/HexDebugOverlay.js';
// Issue #161: registers itself (two small monitors on the user's own desk) as a side effect.
import './building/deskMonitors.js';

// Fork add-on: the growing hex office, home desks, trips and the user's office.
// Issue #267: this is the "Experimental" layout now — the stable rect building it replaced
// (PRs #261/#263/#264) is restored as "Rooms v1" (`addons/building-v1.ts`), which keeps the
// `building` id and the default slot. This one opens in the isometric view (#173).
let activeBuilding: BuildingLayout | null = null;

registerLayout('hex', (scene, stations) => {
  const floor = focusedFloor();
  activeBuilding = new BuildingLayout(scene, stations, {
    storage: typeof window !== 'undefined' ? window.localStorage : undefined,
    // Issue #118: each floor keeps its own room-kind list. The office (room 0, the lobby) is
    // always built either way; only the room list a floor switch restores changes.
    // `ALL_FLOORS` (review: the "show everything" default) maps to no floor option at all,
    // so it keeps using the legacy bare storage key — the exact room list the single
    // building already used before floors existed, with no migration and no data loss.
    floor: floor === ALL_FLOORS ? undefined : floor,
  });
  // The picture over your office door, from this server only; without one the frame keeps its placeholder
  void loadPortrait(scene);
  // Issue #218 step 1: a dev-only preview of the hex office planner's claimed region, off
  // the building's own geometry (x = 200) so it never changes what Gabriel sees by default.
  // No-op (builds no geometry at all) without `?hexDebug=1`.
  mountHexDebugOverlay(scene);
  return activeBuilding;
}, { defaultView: 'isometric', name: 'Experimental' });

// Rooms from server plugins (mission war rooms) become rooms of the building.
registerExtension({
  id: 'building-world-rooms',
  worldChanged: (world) => { activeBuilding?.syncWorldRooms(world.rooms); },
  // A war room's tombstones (issue #127), issue board (issue #146) and live-sessions board
  // (issue #223), pickable by a click.
  pickTargets: () => [
    ...(activeBuilding?.tombstonePickTargets() ?? []),
    ...(activeBuilding?.issuesBoardPickTargets() ?? []),
    ...(activeBuilding?.sessionsBoardPickTargets() ?? []),
  ],
});
