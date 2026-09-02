import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkLifecycleManager } from '../dist/utils/work-lifecycle.js';

const makeOptions = (stateDirectory, extra = {}) => ({
  stateDirectory,
  checkpointAfterMs: 20,
  warningAfterMs: 30,
  criticalAfterMs: 40,
  budgetMs: 50,
  pollIntervalMs: 5,
  ...extra,
});

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-work-life-'));
const manager = new WorkLifecycleManager(makeOptions(dir));
manager.start({ tool: 'read_file', file: '/tmp/a.txt', requestId: 'req-1' });
manager.toolCompleted({ tool: 'edit_block', file: '/repo/src/server.ts', requestId: 2 });
await manager.flushPersistence();

let state = manager.getState();
assert.equal(state.status, 'running');
assert.equal(state.completedOperations, 1);
assert.equal(state.lastTool, 'edit_block');
assert.equal(state.lastFile, '/repo/src/server.ts');
assert.equal(state.lastPath, '/repo/src/server.ts');
assert.equal(state.lastRequestId, '2');

const persistedRunning = JSON.parse(await fs.readFile(path.join(dir, 'current.json'), 'utf8'));
assert.equal(persistedRunning.completedOperations, 1);
assert.equal(persistedRunning.lastRequestId, '2');

const startedAt = state.startedAt;
assert.equal(manager.getBudgetLevel(startedAt + 10), 'normal');
assert.equal(manager.getBudgetLevel(startedAt + 20), 'checkpoint');
assert.match(manager.consumePendingWarning(startedAt + 20), /checkpoint/);
assert.equal(manager.consumePendingWarning(startedAt + 20), undefined);
assert.equal(manager.getBudgetLevel(startedAt + 30), 'warning');
assert.match(manager.consumePendingWarning(startedAt + 30), /warning/);
assert.equal(manager.getBudgetLevel(startedAt + 40), 'critical');
assert.match(manager.consumePendingWarning(startedAt + 40), /critical/);
manager.dispose();
await manager.flushPersistence();

const restored = new WorkLifecycleManager(makeOptions(dir));
const restoredState = restored.getState();
assert.equal(restoredState.id, state.id);
assert.equal(restoredState.status, 'running');
assert.equal(restoredState.completedOperations, 1);
assert.equal(restored.consumePendingWarning(startedAt + 40), undefined);
restored.dispose();

const raceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-work-race-'));
const raceManager = new WorkLifecycleManager(makeOptions(raceDir, { budgetMs: 5_000 }));
raceManager.start({ tool: 'read_file', requestId: 'race-start' });
for (let i = 0; i < 50; i += 1) {
  raceManager.toolCompleted({ tool: `tool-${i}`, requestId: i });
}
await raceManager.interrupt('mcp_cancelled', 'race cancellation');
await raceManager.flushPersistence();
const racePersisted = JSON.parse(await fs.readFile(path.join(raceDir, 'current.json'), 'utf8'));
assert.equal(racePersisted.status, 'interrupted');
assert.equal(racePersisted.interruptionReason, 'mcp_cancelled');
assert.equal(racePersisted.completedOperations, 50);
assert.equal(racePersisted.lastRequestId, '49');

const expiryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-work-expiry-'));
const expiryManager = new WorkLifecycleManager(makeOptions(expiryDir));
expiryManager.start({ tool: 'start_process', requestId: 'expiry' });
const expiryStartedAt = expiryManager.getState().startedAt;
assert.equal(expiryManager.getBudgetLevel(expiryStartedAt + 50), 'expired');
assert.match(expiryManager.consumePendingWarning(expiryStartedAt + 50), /expired/);
await expiryManager.flushPersistence();
const expiryState = expiryManager.getState();
assert.equal(expiryState.status, 'interrupted');
assert.equal(expiryState.interruptionReason, 'budget_expired');
const expiryPersisted = JSON.parse(await fs.readFile(path.join(expiryDir, 'current.json'), 'utf8'));
assert.equal(expiryPersisted.status, 'interrupted');
assert.equal(expiryPersisted.interruptionReason, 'budget_expired');

const cancelDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-work-cancel-'));
const cancelManager = new WorkLifecycleManager(makeOptions(cancelDir, { budgetMs: 5_000 }));
cancelManager.start({ tool: 'read_file', requestId: 'cancel' });
const controller = new AbortController();
controller.signal.addEventListener('abort', () => {
  void cancelManager.interrupt('mcp_cancelled', String(controller.signal.reason));
}, { once: true });
controller.abort('test cancellation');
await cancelManager.flushPersistence();
state = cancelManager.getState();
assert.equal(state.status, 'interrupted');
assert.equal(state.interruptionReason, 'mcp_cancelled');
assert.match(state.interruptionDetail, /test cancellation/);

const failureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-work-failure-'));
const notADirectory = path.join(failureRoot, 'state-dir');
await fs.writeFile(notADirectory, 'not a directory', 'utf8');
let persistenceErrors = 0;
const failureManager = new WorkLifecycleManager(makeOptions(notADirectory, {
  budgetMs: 5_000,
  onPersistenceError: () => { persistenceErrors += 1; },
}));
failureManager.start({ tool: 'read_file' });
failureManager.toolCompleted({ tool: 'read_file' });
await failureManager.interrupt('mcp_cancelled', 'storage failure must be non-fatal');
await failureManager.flushPersistence();
assert.equal(failureManager.getState().status, 'interrupted');
assert.ok(persistenceErrors >= 1);

manager.dispose();
raceManager.dispose();
expiryManager.dispose();
cancelManager.dispose();
failureManager.dispose();
console.log('work lifecycle tests passed');
