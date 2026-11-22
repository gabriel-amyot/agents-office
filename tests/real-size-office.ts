import * as THREE from 'three';
import { addLighting } from '../src/scene/SceneSetup.js';
import { BuildingLayout } from '../src/addons/building/BuildingLayout.js';
import { MAX_TOMBSTONES } from '../src/addons/building/missionRooms.js';
import { AgentManager } from '../src/agents/AgentManager.js';
import { bmadHats } from '../plugins/bmad/client.js';
import { skillsEquipment } from '../plugins/skills/client.js';
import { GithubOfficeExtension } from '../plugins/github/client.js';
import { setFreeCameraLook } from '../src/scene/FreeCamera.js';
import { overviewBounds } from '../src/scene/OverviewCamera.js';
import { IsometricController } from '../src/scene/IsometricCamera.js';

/**
 * Gabriel's real size: the hex Hub/Office/Library, 9 mission rooms (one locked)
 * and 40 agents. Half of the agents wear BMAD hats (one to four) and a quarter
 * wear GitHub cards (one to five), as with the fork plugins on.
 *
 * `buildingRooms` is documentation only, not read by this fixture. Issue #260 (step 7a): before
 * the rented 'desks'/'lab'/'lounge' kinds retired, 40 agents' own overflow used to rent up to
 * 16 extra rect rooms; that overflow absorbs into the hex Hub's own fixed desks and
 * kitchen/play corner instead. Issue #260 steps 2+3: the rect building's own office room
 * (the last rect room `addRoom` ever built) is gone too, replaced by the hex Office —
 * the rect building now never rents a room, full stop.
 */
export const REAL_SIZE = { buildingRooms: 0, missionRooms: 9, agents: 40, hatWearers: 20, cardHolders: 10 } as const;

// 'librarian' included (issue #128 review): the budget fixture must wear every hat it pins.
const PERSONAS = ['dev', 'architect', 'qa', 'pm', 'analyst', 'sm', 'debugger', 'spec-coach', 'data-engineer', 'ux-designer', 'tech-writer', 'librarian'];

function badgesFor(i: number): string[] | undefined {
  if (i >= REAL_SIZE.hatWearers) return undefined;
  return Array.from({ length: (i % 4) + 1 }, (_, k) => PERSONAS[(i + k * 3) % PERSONAS.length]);
}

function issuesFor(i: number): Array<{ number: number; title: string }> | undefined {
  if (i % 4 !== 1) return undefined;
  return Array.from({ length: (i % 5) + 1 }, (_, k) => ({ number: 100 + i * 10 + k, title: `issue ${k}` }));
}

/**
 * Issue #167 v1 (skills equipment): a sequence that cycles through every hand-item
 * kind this catalog maps (one per `HAND_MAP` entry, plus the unmapped-skill toolbox
 * fallback), and both face items (`glasses`, from 2+ skills; `headphones`, from a
 * dedicated skill) — so the budget fixture's worst case actually pins the real
 * bucket count this feature spends, not an undercount from a fixture that never
 * wears any of it. Every 6th agent carries no skills at all, the same "not every
 * agent wears one" shape `badgesFor` already follows.
 */
const SKILL_SEQUENCES: string[][] = [
  ['git'],
  ['jira'],
  ['klever-mr'],
  ['crit:crit'],
  ['code-review'],
  ['bibliotheque-librarian'],
  ['dataviz'],
  ['research'],
  ['investigate'],
  ['totally-unmapped-skill'],
  ['git', 'jira'],
  ['klever-test'],
  ['git', 'klever-test'],
];

function skillsFor(i: number): string[] | undefined {
  if (i % 6 === 5) return undefined;
  return SKILL_SEQUENCES[i % SKILL_SEQUENCES.length];
}

/**
 * Round 2 (issue #167): the raw built-in tool allow-list (`plugins/skills/index.ts`'s
 * `TOOL_ALLOWLIST`), cycled the same way `SKILL_SEQUENCES` is, so this fixture's worst
 * case also pins the 3 new buckets this round actually spends (`terminal-screen`,
 * `pencil`, `globe` — `magnifier` and `open-book` are reused from the skills side, no
 * new bucket). `lastEquipSourceFor` alternates which list actually wins the hand slot
 * (`handItemFor`'s own tie-break otherwise always prefers `skills` when both are
 * present), so both the tool-triggered and the skill-triggered items are exercised,
 * not just whichever the default preference always picks.
 */
const TOOL_SEQUENCES: string[][] = [['Bash'], ['Grep'], ['Glob'], ['Read'], ['Edit'], ['Write'], ['WebSearch'], ['WebFetch'], ['Task']];

function toolsFor(i: number): string[] {
  return TOOL_SEQUENCES[i % TOOL_SEQUENCES.length];
}

/**
 * Review (issue #167 round 2): alternating on `i % 2` let `code-review`'s loupe silently
 * never win the hand slot — its only two non-suppressed occurrences (agents 4 and 30,
 * `SKILL_SEQUENCES[4]`) both landed on the `i % 2 === 0` ("tool wins") side, so the fixture
 * never actually equipped it despite the comment above claiming full coverage. Alternating
 * on which full lap of `SKILL_SEQUENCES` this agent falls in, instead of on the agent's own
 * index, guarantees every sequence's first lap (agents 0-12, repeat 0) wins the hand slot
 * via `skill` before any `tool` override can suppress it — the fixture's worst case must
 * equip every mapped kind at least once, not just the ones a lucky index happens to land on.
 */
function lastEquipSourceFor(i: number): 'skill' | 'tool' | undefined {
  if (!skillsFor(i)) return 'tool';
  const lap = Math.floor(i / SKILL_SEQUENCES.length);
  return lap % 2 === 0 ? 'skill' : 'tool';
}

/**
 * Build the office at the real size without a browser. The caller sets up a
 * jsdom `document` with a canvas stub first (toon gradients, signs, boards, cards).
 */
export function buildRealSizeOffice(): { scene: THREE.Scene; manager: AgentManager; layout: BuildingLayout; github: GithubOfficeExtension } {
  const scene = new THREE.Scene();
  addLighting(scene);
  // Issue #260 step 7b item 6: `createOffice` (the rect hall) is gone from this fixture — it
  // never ran in production for the 'building' layout to begin with (`main.ts`'s own
  // `layoutId === 'activity' ? createOffice(scene) : new Map()`), and `BuildingLayout`'s own
  // constructor (`rebuildHexOffice`) builds its own hex Hub/Office/Library stations into a
  // plain, empty `Map` without reading anything `createOffice` would have seeded. The rect
  // hall's own bookshelf (`Bookshelf.ts`'s `Math.random`) was the one source of nondeterminism
  // this fixture used to seed; the hex library carries no bookshelf of its own, so there is
  // nothing left here to seed.
  const layout = new BuildingLayout(scene, new Map());
  // Worst case: every war room at the tombstone cap, not just a handful.
  layout.syncWorldRooms(Array.from({ length: REAL_SIZE.missionRooms }, (_, i) => ({
    id: `m${i}`, kind: 'mission', title: `Mission ${i}`, state: i === 8 ? 'locked' as const : 'open' as const,
    sleepers: Array.from({ length: MAX_TOMBSTONES }, (_, j) => ({ id: `m${i}-tomb-${j}`, endedAt: '2026-11-18' })),
    walls: { statement: 'x', docs: ['a'], issues: [], kanban: [] },
  })));
  const manager = new AgentManager(scene, layout);
  for (let i = 0; i < REAL_SIZE.agents; i++) {
    manager.addAgent({
      id: `a${i}`, name: `agent ${i}`, activity: 'implementing',
      extras: {
        group: { id: `g${i % 11}`, label: `ws${i % 11}` }, badges: badgesFor(i), issues: issuesFor(i),
        skills: skillsFor(i), tools: toolsFor(i), lastEquipSource: lastEquipSourceFor(i),
      },
    });
  }
  // Worst case for war-room furniture: push every open mission room past its desk cap
  // (half debugging, half other desk-like work) at least once. Growth persists at its
  // peak even after these agents leave, so the budget test sees the heaviest room.
  for (let room = 0; room < REAL_SIZE.missionRooms - 1; room++) {
    const stressIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      const id = `stress-${room}-${i}`;
      stressIds.push(id);
      manager.addAgent({ id, name: id, activity: i < 4 ? 'debugging' : 'implementing', extras: { room: `m${room}` } });
    }
    layout.update();
    for (const id of stressIds) manager.removeAgent(id);
  }
  const github = new GithubOfficeExtension();
  github.start(scene);
  bmadHats.agentsChanged?.(manager.getAgents());
  skillsEquipment.agentsChanged?.(manager.getAgents());
  github.agentsChanged(manager.getAgents());
  return { scene, manager, layout, github };
}

/** The two modes the browser starts with (#173 dropped the overview mode): first person at its start pose, and the isometric view of the whole building. */
export function realSizeCameras(scene: THREE.Scene, aspect = 1280 / 800): { firstPerson: THREE.PerspectiveCamera; isometric: THREE.OrthographicCamera } {
  const firstPerson = new THREE.PerspectiveCamera(60, aspect, 0.1, 100);
  firstPerson.position.set(-12, 5.5, 11);
  setFreeCameraLook(firstPerson, firstPerson.position, new THREE.Vector3(2, 1, -2));
  const isometric = new THREE.OrthographicCamera();
  const iso = new IsometricController();
  iso.frame(overviewBounds(scene), aspect);
  iso.applyTo(isometric, aspect, 60);
  for (const camera of [firstPerson, isometric]) {
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
  }
  return { firstPerson, isometric };
}
