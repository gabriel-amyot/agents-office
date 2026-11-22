import * as THREE from 'three';
import { registerExtension, type OfficeExtension } from '../../src/extensions.js';
import type { ManagedAgent } from '../../src/agents/AgentManager.js';
import type { LayoutStrategy } from '../../src/layout/LayoutStrategy.js';
import { handItemFor, faceItemFor, buildHandItem, buildFaceItem, type HandItem, type FaceKind } from './items.js';

/**
 * Skills plugin, browser part (issue #167, equipment catalog): equips the one true
 * newest-introduced item in the right hand, across both `extras.skills` (a named `Skill`
 * tool call) and `extras.tools` (round 2: a fixed allow-list of raw built-in tool calls,
 * `lastEquipSource` says which list had it), plus an independent, recency-free face item
 * (glasses or headphones). The head stays the persona hat's slot (`plugins/bmad/client.ts`)
 * — a skill or tool item never competes for head space.
 *
 * Issue #227 (the crib's own trip): a hand item never just appears any more — an agent walks
 * to the tool crib first, a visual side trip that never touches the agent's real seat, the
 * same shape `AgentManager.setDeskTalker` already uses for the desk conversation spot. Immediate
 * equip (no trip) stays for: this entry's very first observation (a page reload restoring
 * state is not "loading a skill"), clearing the item entirely (nothing to walk up and collect),
 * an agent waiting on Gabriel (AC2: it must not leave its place), and a layout with no crib at
 * all (the flat activity layout, and every existing unit test that calls `agentsChanged` with
 * no `layout` argument) — the same graceful degradation every optional `LayoutStrategy` method
 * already follows.
 */

/** A `userData` marker, not `.name` (review: `.name` stays the item's own kind, from
 * `plugins/skills/items.ts`'s `group(kind, ...)`, so a test or an inspector can tell
 * which kind is actually worn without sniffing geometry dimensions). */
const HAND_ITEM_MARKER = 'skillsHandItem';
const FACE_ITEM_MARKER = 'skillsFaceItem';
/** Held low and slightly forward, roughly where a closed hand would hold a small tool. */
const HAND_OFFSET: [number, number, number] = [0, -0.01, 0.03];
/** At the same depth as the eyes (StickFigureParts.ts's `FACE_DEPTH`), just above them. */
const FACE_OFFSET: [number, number, number] = [0, 0.05, 0.19];

/** A hand-item change in flight: the figure walks to its claimed crib spot, picks up
 * `hand` once it arrives, then walks back to its real seat. */
interface PendingTrip {
  hand: HandItem | undefined;
  handKey: string;
  cribIndex: number;
  phase: 'toCrib' | 'returning';
}

interface Worn {
  managed: ManagedAgent;
  figure: ManagedAgent['figure'];
  handKey: string;
  faceKey: string;
  handGroup: THREE.Group | null;
  faceGroup: THREE.Group | null;
  trip?: PendingTrip;
}

const worn = new Map<string, Worn>();

/** Which crib stand index each tripping agent currently holds (issue #227 AC3: so two agents
 * reaching the crib at once never claim the same one). */
const cribClaims = new Map<string, number>();

function claimCribSpot(agentId: string, count: number): number {
  const taken = new Set(cribClaims.values());
  for (let i = 0; i < count; i++) {
    if (!taken.has(i)) {
      cribClaims.set(agentId, i);
      return i;
    }
  }
  // Every spot taken (more concurrent trippers than the ring seats, past AC3's own 5): share
  // the first one rather than throw — a crowded crib still serves everyone, just tighter.
  cribClaims.set(agentId, 0);
  return 0;
}

function releaseCribSpot(agentId: string): void {
  cribClaims.delete(agentId);
}

function handKeyOf(item: HandItem | undefined): string {
  if (!item) return '';
  return item.tint ? `${item.kind}:${item.tint.getHexString()}` : item.kind;
}

function skillsOf(managed: ManagedAgent): string[] {
  const skills = managed.info.extras?.skills;
  return Array.isArray(skills) ? skills.filter((skill): skill is string => typeof skill === 'string') : [];
}

function toolsOf(managed: ManagedAgent): string[] {
  const tools = managed.info.extras?.tools;
  return Array.isArray(tools) ? tools.filter((tool): tool is string => typeof tool === 'string') : [];
}

function removeHand(entry: Worn): void {
  entry.handGroup?.removeFromParent();
  entry.handGroup = null;
}

function removeFace(entry: Worn): void {
  entry.faceGroup?.removeFromParent();
  entry.faceGroup = null;
}

function equipHand(entry: Worn, hand: HandItem | undefined, handKey: string): void {
  removeHand(entry);
  if (hand) {
    entry.handGroup = buildHandItem(hand);
    entry.handGroup.position.set(...HAND_OFFSET);
    entry.handGroup.userData[HAND_ITEM_MARKER] = true;
    entry.figure.joints.rightHand.add(entry.handGroup);
  }
  entry.handKey = handKey;
}

export const skillsEquipment: OfficeExtension = {
  id: 'skills-equipment',
  plugin: 'skills',
  agentsChanged(agents: ManagedAgent[], layout?: LayoutStrategy) {
    const present = new Set<string>();
    const cribSpots = layout?.toolCribSpots?.() ?? [];
    for (const managed of agents) {
      present.add(managed.info.id);
      const skills = skillsOf(managed);
      const tools = toolsOf(managed);
      const hand = handItemFor(skills, tools, managed.info.extras?.lastEquipSource);
      const face = faceItemFor(skills);
      const handKey = handKeyOf(hand);
      const faceKey = face ?? '';

      let entry = worn.get(managed.info.id);
      const isFreshEntry = !entry || entry.figure !== managed.figure;
      if (entry && entry.figure !== managed.figure) {
        removeHand(entry);
        removeFace(entry);
        releaseCribSpot(managed.info.id);
        entry = undefined;
      }
      if (!entry) {
        entry = { managed, figure: managed.figure, handKey: '', faceKey: '', handGroup: null, faceGroup: null };
        worn.set(managed.info.id, entry);
      }
      entry.managed = managed;

      if (entry.faceKey !== faceKey) {
        removeFace(entry);
        if (face) {
          entry.faceGroup = buildFaceItem(face as FaceKind);
          entry.faceGroup.position.set(...FACE_OFFSET);
          entry.faceGroup.userData[FACE_ITEM_MARKER] = true;
          managed.figure.joints.head.add(entry.faceGroup);
        }
        entry.faceKey = faceKey;
      }

      if (entry.trip) {
        // A trip is already under way (AC1): either the figure is still walking toward it, or
        // `update()` below hasn't caught the arrival yet this frame. A newer skill load mid-trip
        // chases the latest item instead of equipping one that is already stale on arrival;
        // clearing the item entirely cancels the whole trip (nothing left to walk up and get).
        if (entry.trip.handKey !== handKey) {
          if (hand) {
            entry.trip.hand = hand;
            entry.trip.handKey = handKey;
          } else {
            releaseCribSpot(managed.info.id);
            entry.trip = undefined;
            equipHand(entry, undefined, handKey);
            const seat = managed.seat;
            if (seat) managed.figure.moveTo(seat.position, seat.lookAt);
          }
        }
      } else if (entry.handKey !== handKey) {
        const skipTrip = isFreshEntry || !hand || managed.figure.isWaiting || cribSpots.length === 0;
        if (skipTrip) {
          equipHand(entry, hand, handKey);
        } else {
          // Issue #227 AC1: walk to the crib before the new item shows in hand.
          const cribIndex = claimCribSpot(managed.info.id, cribSpots.length);
          const spot = cribSpots[cribIndex]!;
          managed.figure.moveTo(spot.position, spot.lookAt);
          entry.trip = { hand, handKey, cribIndex, phase: 'toCrib' };
        }
      }
    }
    for (const [id, entry] of worn) {
      if (present.has(id)) continue;
      removeHand(entry);
      removeFace(entry);
      releaseCribSpot(id);
      worn.delete(id);
    }
  },
  update() {
    // Advance every trip still in flight: pick up the item once the figure stops walking
    // toward the crib, then send it back to its real seat (issue #227). `AgentManager.update`
    // (which drives `figure.walking`) runs earlier in the same frame, so this always reads the
    // figure's current-frame arrival, never a stale one.
    for (const [id, entry] of worn) {
      const trip = entry.trip;
      if (!trip || entry.figure.walking) continue;
      if (trip.phase === 'toCrib') {
        equipHand(entry, trip.hand, trip.handKey);
        releaseCribSpot(id);
        const seat = entry.managed.seat;
        if (seat) {
          entry.figure.moveTo(seat.position, seat.lookAt);
          trip.phase = 'returning';
        } else {
          entry.trip = undefined;
        }
      } else {
        entry.trip = undefined;
      }
    }
  },
};

registerExtension(skillsEquipment);
