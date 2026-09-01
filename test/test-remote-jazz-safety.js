/** Regression tests for Jazz remote-device execution invariants. */
import assert from 'node:assert';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function makeDevice({ claim = true, complete = async () => {} } = {}) {
  const { MCPDevice } = await import('../dist/remote-device/device.js');
  const device = new MCPDevice({ persistSession: false });
  const calls = [];
  const completions = [];
  const controls = [];
  device.deviceId = '11111111-1111-4111-8111-111111111111';
  device.remoteChannel = {
    markCallExecuting: async (id) => {
      calls.push(['claim', id]);
      if (claim instanceof Error) throw claim;
      return claim;
    },
    updateCallResult: async (...args) => {
      completions.push(args);
      return complete(...args);
    },
    forceReconnect: async () => controls.push('reconnect'),
  };
  device.desktop = {
    callClientTool: async (name, args) => {
      calls.push(['execute', name, args]);
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };
  return { device, calls, completions, controls };
}
function payload(id = 'call-1', tool = 'get_config') {
  return {
    new: {
      id,
      tool_name: tool,
      tool_args: {},
      device_id: '11111111-1111-4111-8111-111111111111',
      metadata: {},
    },
  };
}

async function testClaimFailureFailsClosed() {
  const { device, calls, completions } = await makeDevice({ claim: new Error('network down') });
  await device.handleNewToolCall(payload());
  assert.deepStrictEqual(calls.map((x) => x[0]), ['claim']);
  assert.strictEqual(completions.length, 0);
  console.log('✓ claim error fails closed before local execution');
}

async function testUnclaimedCallDoesNotExecute() {
  const { device, calls } = await makeDevice({ claim: false });
  await device.handleNewToolCall(payload());
  assert.deepStrictEqual(calls.map((x) => x[0]), ['claim']);
  console.log('✓ authority claim=false prevents local execution');
}

async function testClaimPrecedesExecutionAndDuplicateIsSuppressed() {
  const { device, calls, completions } = await makeDevice();
  await device.handleNewToolCall(payload());
  await device.handleNewToolCall(payload());
  assert.deepStrictEqual(calls.map((x) => x[0]), ['claim', 'execute']);
  assert.strictEqual(completions.length, 1);
  assert.strictEqual(completions[0][1], 'completed');
  console.log('✓ claim precedes one execution and duplicate delivery is suppressed');
}
async function testCompletionFailureNeverReexecutesInProcess() {
  const { device, calls } = await makeDevice({
    complete: async () => { throw new Error('completion transport failed'); },
  });
  await device.handleNewToolCall(payload('call-ambiguous'));
  await device.handleNewToolCall(payload('call-ambiguous'));
  assert.deepStrictEqual(calls.map((x) => x[0]), ['claim', 'execute']);
  console.log('✓ ambiguous completion failure does not replay the side effect');
}

async function testReconnectRunsOnlyAfterCompletion() {
  const order = [];
  const { device, controls } = await makeDevice({
    complete: async () => { order.push('complete'); },
  });
  const original = device.remoteChannel.forceReconnect;
  device.remoteChannel.forceReconnect = async (...args) => {
    order.push('reconnect');
    return original(...args);
  };
  await device.handleNewToolCall(payload('call-reconnect', '__control.reconnect'));
  assert.deepStrictEqual(order, ['complete']);
  await sleep(350);
  assert.deepStrictEqual(order, ['complete', 'reconnect']);
  assert.deepStrictEqual(controls, ['reconnect']);
  console.log('✓ reconnect destroys transport only after completion commit');
}

const cases = [
  testClaimFailureFailsClosed,
  testUnclaimedCallDoesNotExecute,
  testClaimPrecedesExecutionAndDuplicateIsSuppressed,
  testCompletionFailureNeverReexecutesInProcess,
  testReconnectRunsOnlyAfterCompletion,
];

let failed = 0;
for (const test of cases) {
  try { await test(); }
  catch (error) { failed++; console.error(`✗ ${test.name}:`, error); }
}
console.log(`\n${cases.length - failed}/${cases.length} Jazz safety cases passed`);
if (failed) process.exit(1);
