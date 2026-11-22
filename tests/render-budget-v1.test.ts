/**
 * Issue #267: Rooms v1 (`src/addons/building-v1/`) gets its own honest draw-call measurement,
 * the same real-size fixture (16 building rooms, 9 mission rooms, 40 agents, hats and cards)
 * `tests/render-budget.test.ts` already runs against the hex layout, ported to the restored
 * rect building (`tests/real-size-office-v1.ts`).
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
dom.window.HTMLCanvasElement.prototype.getContext = (() => new Proxy({}, {
  get: () => () => undefined,
  set: () => true,
})) as never;
const { buildRealSizeOffice, realSizeCameras, REAL_SIZE } = await import('./real-size-office-v1.js');
const { countDrawCalls, DRAW_CALL_BUDGET } = await import('../src/scene/RenderBudget.js');
const { StaticBatch } = await import('../src/scene/StaticMerge.js');
const { FigureBatch } = await import('../src/characters/FigureBatch.js');
after(() => {
  dom.window.close();
  Reflect.deleteProperty(globalThis, 'document');
});

test('Rooms v1 at the real size (16 rooms, 9 mission rooms, 40 agents, hats and cards) stays under the draw-call budget from every start view', () => {
  const { scene, manager } = buildRealSizeOffice();
  scene.updateMatrixWorld();
  new StaticBatch(scene).update();
  new FigureBatch(scene).sync(manager.getAgents().map((managed) => managed.figure.group));
  const cameras = realSizeCameras(scene);
  for (const [view, camera] of Object.entries(cameras)) {
    const after = countDrawCalls(scene, camera);
    assert.ok(after.total < DRAW_CALL_BUDGET, `${view}: ${JSON.stringify(after)} over the ${DRAW_CALL_BUDGET} budget`);
  }
  assert.equal(REAL_SIZE.buildingRooms, 16);
});
