import assert from 'node:assert/strict';
import { test } from 'node:test';
import { missionRecencyAt, byRecencyNewestFirst } from '../src/addons/building/missionRecency.js';

test('missionRecencyAt: createdAt alone is the signal for a mission with no ended sessions', () => {
  assert.equal(missionRecencyAt({ createdAt: '2026-11-01T00:00:00Z' }), Date.parse('2026-11-01T00:00:00Z'));
});

test('missionRecencyAt: a later sleeper endedAt wins over an older createdAt', () => {
  const room = {
    createdAt: '2026-01-01T00:00:00Z',
    sleepers: [{ id: 's1', endedAt: '2026-11-20T00:00:00Z' }, { id: 's2', endedAt: '2026-06-01T00:00:00Z' }],
  };
  assert.equal(missionRecencyAt(room), Date.parse('2026-11-20T00:00:00Z'));
});

test('missionRecencyAt: no timestamps at all sorts as the oldest, never throws', () => {
  assert.equal(missionRecencyAt({}), -Infinity);
  assert.equal(missionRecencyAt({ createdAt: 'not-a-date' }), -Infinity);
});

test('byRecencyNewestFirst: newest createdAt sorts first', () => {
  const older = { id: 'a', createdAt: '2026-01-01T00:00:00Z' };
  const newer = { id: 'b', createdAt: '2026-11-01T00:00:00Z' };
  assert.deepEqual([older, newer].sort(byRecencyNewestFirst), [newer, older]);
});

test('byRecencyNewestFirst: an idle room (no recent sleeper, old createdAt) sorts after an active one', () => {
  const idle = { id: 'idle', createdAt: '2026-01-01T00:00:00Z', sleepers: [{ id: 's', endedAt: '2026-01-05T00:00:00Z' }] };
  const active = { id: 'active', createdAt: '2026-11-20T00:00:00Z' };
  assert.deepEqual([idle, active].sort(byRecencyNewestFirst), [active, idle]);
});

test('byRecencyNewestFirst: equal recency ties break on id, deterministically in either input order (AC4: same reload twice, same layout)', () => {
  const a = { id: 'a', createdAt: '2026-01-01T00:00:00Z' };
  const b = { id: 'b', createdAt: '2026-01-01T00:00:00Z' };
  assert.deepEqual([a, b].sort(byRecencyNewestFirst), [a, b]);
  assert.deepEqual([b, a].sort(byRecencyNewestFirst), [a, b]);
});

test('byRecencyNewestFirst: sorting the same list twice gives the same order (AC4)', () => {
  const rooms = [
    { id: 'r1', createdAt: '2026-11-01T00:00:00Z' },
    { id: 'r2', createdAt: '2026-10-15T00:00:00Z' },
    { id: 'r3' },
    { id: 'r4', createdAt: '2026-11-18T00:00:00Z', sleepers: [{ id: 's', endedAt: '2026-11-19T00:00:00Z' }] },
  ];
  const first = [...rooms].sort(byRecencyNewestFirst);
  const second = [...rooms].sort(byRecencyNewestFirst);
  assert.deepEqual(first.map((r) => r.id), second.map((r) => r.id));
  assert.deepEqual(first.map((r) => r.id), ['r4', 'r1', 'r2', 'r3']);
});
