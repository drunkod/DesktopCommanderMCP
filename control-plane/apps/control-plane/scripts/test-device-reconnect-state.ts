import assert from "node:assert/strict";
import {
  heartbeatStatusDuringReconnect,
  isReconnectReady,
  reconnectTargetGeneration,
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

assert.equal(reconnectTargetGeneration({ reconnectGeneration: 8 }), 8);
assert.equal(reconnectTargetGeneration({ reconnectGeneration: 0 }), null);
assert.equal(reconnectTargetGeneration({ reconnectGeneration: 1.5 }), null);
assert.equal(reconnectTargetGeneration({}), null);
assert.equal(reconnectTargetGeneration(null), null);

assert.equal(
  isReconnectReady(
    {
      status: "online",
      reconnectGeneration: 8,
      reconnectRequestedAt: marker,
      lastSeenAt: newer,
    },
    completedAt,
    8,
  ),
  false,
);
assert.equal(
  isReconnectReady(
    {
      status: "reconnecting",
      reconnectGeneration: 8,
      reconnectRequestedAt: null,
      lastSeenAt: newer,
    },
    completedAt,
    8,
  ),
  false,
);
assert.equal(
  isReconnectReady(
    {
      status: "online",
      reconnectGeneration: 7,
      reconnectRequestedAt: null,
      lastSeenAt: newer,
    },
    completedAt,
    8,
  ),
  false,
);
assert.equal(
  isReconnectReady(
    {
      status: "online",
      reconnectGeneration: 8,
      reconnectRequestedAt: null,
      lastSeenAt: completedAt,
    },
    completedAt,
    8,
  ),
  false,
);
assert.equal(
  isReconnectReady(
    {
      status: "online",
      reconnectGeneration: 8,
      reconnectRequestedAt: null,
      lastSeenAt: newer,
    },
    completedAt,
    8,
  ),
  true,
);

console.log("device reconnect state integration: ok");
