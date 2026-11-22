import type { WorldRoom } from '../../extensions.js';

/**
 * Issue #225 (party round 7, unanimous): "the newest mission sits nearest the hub" needs a
 * recency signal per room. `WorldRoom` carries no single "last worked" timestamp — a mission
 * still being worked right now reports through its live sessions list (`displayWall.ts`), not
 * this room data — so the honest available signal is history: the room's own `createdAt`, and
 * every ended session's own `endedAt` (`sleepers`), whichever is later. A mission with no
 * sleepers yet (brand new, or never closed a session) falls back to `createdAt` alone. Missing
 * or unparseable timestamps sort as the oldest (`-Infinity`), never throw.
 */
export function missionRecencyAt(room: Pick<WorldRoom, 'createdAt' | 'sleepers'>): number {
  const stamps = [room.createdAt, ...(room.sleepers ?? []).map((sleeper) => sleeper.endedAt)]
    .map((stamp) => (stamp ? Date.parse(stamp) : NaN))
    .filter((time) => Number.isFinite(time));
  return stamps.length > 0 ? Math.max(...stamps) : -Infinity;
}

/**
 * Newest-first order, with a stable tie-break on `id` (issue #225 AC4: the same reload twice
 * must give the same layout — two rooms with equal or absent recency would otherwise sort
 * however `Array.sort`'s own input order happened to be that particular poll).
 *
 * Review round 1 (codex): comparing by equality first, not by subtracting, matters because two
 * rooms that both have no valid timestamp carry the exact same sentinel (`-Infinity`); their
 * difference is `NaN`, which `!== 0` is true for, so the old subtract-then-check shape returned
 * `NaN` itself (never reaching the `id` tie-break below) and left those rooms in whatever order
 * they happened to arrive in — breaking AC4 for a wing with more than one timestamp-less room.
 */
export function byRecencyNewestFirst(
  a: Pick<WorldRoom, 'id' | 'createdAt' | 'sleepers'>,
  b: Pick<WorldRoom, 'id' | 'createdAt' | 'sleepers'>,
): number {
  const recencyA = missionRecencyAt(a);
  const recencyB = missionRecencyAt(b);
  if (recencyA !== recencyB) return recencyB - recencyA;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
