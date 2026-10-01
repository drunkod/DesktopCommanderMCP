import assert from "node:assert/strict";
import {
  heartbeatStatusDuringReconnect,
  isReconnectReady,
  registrationReconnectPatch,
} from "../lib/device-reconnect-state";

const completedAt = new Date("2026-10-01T12:00:00.000Z");
const newer = new Date("2026-10-01T12:00:01.000Z");
const marker = new Date("2026-10-01T12:00:00.500Z");

assert.deepEqual(
  registrationReconnectPatch({
    reconnectGeneration: 7,
    reconnectRequestedAt: marker,
  }),
  {
    reconnectGeneration: 8,
    reconnectRequestedAt: undefined,
  },
);
assert.deepEqual(
  registrationReconnectPatch({
    reconnectGeneration: 7,
    reconnectRequestedAt: null,
  }),
  {
    reconnectGeneration: 7,
    reconnectRequestedAt: undefined,
  },
);

assert.equal(
  heartbeatStatusDuringReconnect(
    { reconnectRequestedAt: marker },
    "online",
  ),
  "reconnecting",
);
assert.equal(
  heartbeatStatusDuringReconnect(
    { reconnectRequestedAt: marker },
    "offline",
  ),
  "offline",
);
assert.equal(
  heartbeatStatusDuringReconnect(
    { reconnectRequestedAt: null },
    "online",
  ),
  "online",
);

assert.equal(
  isReconnectReady(
    { status: "online", reconnectRequestedAt: marker, lastSeenAt: newer },
    completedAt,
  ),
  false,
);
assert.equal(
  isReconnectReady(
    { status: "reconnecting", reconnectRequestedAt: null, lastSeenAt: newer },
    completedAt,
  ),
  false,
);
assert.equal(
  isReconnectReady(
    { status: "online", reconnectRequestedAt: null, lastSeenAt: completedAt },
    completedAt,
  ),
  false,
);
assert.equal(
  isReconnectReady(
    { status: "online", reconnectRequestedAt: null, lastSeenAt: newer },
    completedAt,
  ),
  true,
);

console.log("device reconnect state integration: ok");
