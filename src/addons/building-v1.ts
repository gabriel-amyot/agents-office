import { registerLayout } from '../layout/registry.js';
import { registerExtension } from '../extensions.js';
import { BuildingLayoutV1 } from './building-v1/BuildingLayout.js';
import { loadPortrait } from './building/portrait.js';
import { ALL_FLOORS } from '../floors/FloorRegistry.js';
import { focusedFloor } from '../floors/floorState.js';
// Issue #161 (restored for Rooms v1, issue #267): registers itself (two small monitors on the
// user's own desk) as a side effect. Its own id (`desk-monitors-v1`) and scene room name
// (`room-0-office`) never collide with the hex layout's own copy (`addons/building/deskMonitors.ts`,
// id `desk-monitors`, room name `hex-office-desk`) — both modules load eagerly regardless of
// which layout is active, but each one only mounts once its own named room exists in the scene.
import './building-v1/deskMonitors.js';

/**
 * Issue #267: the stable rect building, restored verbatim (plus the floor-independent primitives
 * it always shared with the hex layout and the library scene — `RoomPlanner.ts`, `roomLabels.ts`,
 * `portrait.ts`, `tombstoneNames.ts`, `missionsBoard.ts`, `displayWall.ts`, all untouched since
 * 1a665a6) from the last commit before the hex work (PRs #261/#263/#264) replaced it. This is
 * "Rooms v1": the default layout, registered under the historical `building` id so a stored
 * preference from before the hex work (`localStorage['agents-office.layout'] === 'building'`)
 * keeps resolving to the stable layout it always meant, with no migration code needed.
 */
let activeBuilding: BuildingLayoutV1 | null = null;

registerLayout('building', (scene, stations) => {
  const floor = focusedFloor();
  activeBuilding = new BuildingLayoutV1(scene, stations, {
    storage: typeof window !== 'undefined' ? window.localStorage : undefined,
    floor: floor === ALL_FLOORS ? undefined : floor,
  });
  // The picture over your office door, from this server only; without one the frame keeps its placeholder
  void loadPortrait(scene);
  return activeBuilding;
}, { makeDefault: true, defaultView: 'isometric', name: 'Rooms v1' });

// Rooms from server plugins (mission war rooms) become rooms of the building.
registerExtension({
  id: 'building-v1-world-rooms',
  worldChanged: (world) => { activeBuilding?.syncWorldRooms(world.rooms); },
  pickTargets: () => [
    ...(activeBuilding?.tombstonePickTargets() ?? []),
    ...(activeBuilding?.issuesBoardPickTargets() ?? []),
    ...(activeBuilding?.sessionsBoardPickTargets() ?? []),
  ],
});
