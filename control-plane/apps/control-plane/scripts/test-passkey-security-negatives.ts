import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const temp = mkdtempSync(path.join(tmpdir(), "dc-passkey-negative-"));
const dbPath = path.join(temp, "auth.sqlite");
const origin = "https://step8-passkey.test";
const rpID = "step8-passkey.test";

Object.assign(process.env, {
  APP_ORIGIN: origin,
  BETTER_AUTH_SECRET: "step8-negative-secret-step8-negative-0001",
  BETTER_AUTH_DB_PATH: dbPath,
  JAZZ_APP_ID: "step8-negative-app",
  JAZZ_SERVER_URL: "ws://127.0.0.1:1625",
  JAZZ_INTERNAL_SERVER_URL: "ws://127.0.0.1:1625",
  JAZZ_ADMIN_SECRET: "step8-admin",
  JAZZ_BACKEND_SECRET: "step8-backend",
  JAZZ_JWKS_URL: `${origin}/.well-known/jazz-jwks`,
});
Object.assign(process.env, {
  JAZZ_TOKEN_PRIVATE_JWK_B64: "e30",
  JAZZ_TOKEN_PUBLIC_JWK_B64: "e30",
  REMOTE_MCP_RESOURCE: `${origin}/mcp`,
});

const migration = spawnSync(
  "./node_modules/.bin/auth",
  ["migrate", "--config", "./lib/auth-migration-config.ts", "--yes"],
  { cwd: root, env: process.env, encoding: "utf8" },
);
if (migration.status !== 0) {
  process.stderr.write(migration.stdout ?? "");
  process.stderr.write(migration.stderr ?? "");
  throw new Error(`disposable auth migration failed with ${migration.status}`);
}

const require = createRequire(import.meta.url);
const passkeyEntry = require.resolve("@better-auth/passkey");
const nestedNodeModules = path.resolve(path.dirname(passkeyEntry), "../../..");
const serverModule = pathToFileURL(path.join(nestedNodeModules, "@simplewebauthn/server/esm/index.js")).href;
const helperModule = pathToFileURL(path.join(nestedNodeModules, "@simplewebauthn/server/esm/helpers/index.js")).href;
const { verifyAuthenticationResponse, verifyRegistrationResponse } = await import(serverModule);
const { isoBase64URL, isoCBOR } = await import(helperModule);
const { auth } = await import("../lib/auth.ts");
const { createPasskeyAccountRegistrationIntent } = await import("../lib/passkey-enrollment.ts");
const ctx = await auth.$context;

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = publicKey.export({ format: "jwk" });
assert.ok(jwk.x && jwk.y, "P-256 JWK coordinates missing");
const decodeB64u = (value: string) => Buffer.from(value, "base64url");
const credentialId = Buffer.from("step8-negative-credential-0001", "utf8");
const credentialIdB64u = isoBase64URL.fromBuffer(credentialId);
const cosePublicKey = isoCBOR.encode(new Map<number, unknown>([
  [1, 2],
  [3, -7],
  [-1, 1],
  [-2, decodeB64u(jwk.x)],
  [-3, decodeB64u(jwk.y)],
]));
const rpIdHash = createHash("sha256").update(rpID).digest();

function cookiePair(response: Response): string {
  const value = response.headers.get("set-cookie");
  assert.ok(value, "passkey options response did not set challenge cookie");
  return value.split(";", 1)[0]!;
}
async function getOptions(pathname: string) {
  const response = await auth.handler(new Request(`${origin}${pathname}`, {
    method: "GET",
    headers: { origin },
  }));
  assert.equal(response.status, 200, `options request failed: ${pathname}`);
  return { body: await response.json() as any, cookie: cookiePair(response) };
}

async function postResponse(pathname: string, cookie: string, responseBody: unknown) {
  return auth.handler(new Request(`${origin}${pathname}`, {
    method: "POST",
    headers: {
      origin,
      cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify(responseBody),
  }));
}

function clientData(type: "webauthn.create" | "webauthn.get", challenge: string) {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), "utf8");
}
function registrationResponse(challenge: string, uv: boolean) {
  const count = Buffer.alloc(4);
  const credentialLength = Buffer.alloc(2);
  credentialLength.writeUInt16BE(credentialId.length);
  const flags = 0x01 | 0x40 | (uv ? 0x04 : 0);
  const authData = Buffer.concat([
    rpIdHash,
    Buffer.from([flags]),
    count,
    Buffer.alloc(16),
    credentialLength,
    credentialId,
    Buffer.from(cosePublicKey),
  ]);
  const client = clientData("webauthn.create", challenge);
  const attestationObject = isoCBOR.encode(new Map<string, unknown>([
    ["fmt", "none"],
    ["attStmt", new Map()],
    ["authData", authData],
  ]));
  return {
    id: credentialIdB64u,
    rawId: credentialIdB64u,
    type: "public-key",
    response: {
      clientDataJSON: isoBase64URL.fromBuffer(client),
      attestationObject: isoBase64URL.fromBuffer(attestationObject),
      transports: ["internal"],
    },
    clientExtensionResults: {},
    authenticatorAttachment: "platform",
  };
}

function authenticationResponse(challenge: string, uv: boolean, counter: number) {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(counter);
  const flags = 0x01 | (uv ? 0x04 : 0);
  const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([flags]), count]);
  const client = clientData("webauthn.get", challenge);
  const clientHash = createHash("sha256").update(client).digest();
  const signature = sign("sha256", Buffer.concat([authenticatorData, clientHash]), privateKey);
  return {
    id: credentialIdB64u,
    rawId: credentialIdB64u,
    type: "public-key",
    response: {
      clientDataJSON: isoBase64URL.fromBuffer(client),
      authenticatorData: isoBase64URL.fromBuffer(authenticatorData),
      signature: isoBase64URL.fromBuffer(signature),
      userHandle: null,
    },
    clientExtensionResults: {},
    authenticatorAttachment: "platform",
  };
}

try {
  const registrationContext = await createPasskeyAccountRegistrationIntent();
  const registration = await getOptions(
    `/api/auth/passkey/generate-register-options?context=${encodeURIComponent(registrationContext)}`,
  );
  const noUvRegistration = registrationResponse(registration.body.challenge, false);
  const controlRegistration = await verifyRegistrationResponse({
    response: noUvRegistration,
    expectedChallenge: registration.body.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: false,
  });
  assert.equal(controlRegistration.verified, true, "registration fixture is invalid apart from UV");
  const rejectedRegistration = await postResponse(
    "/api/auth/passkey/verify-registration",
    registration.cookie,
    { response: noUvRegistration, createSession: true, name: "Negative UV passkey" },
  );
  assert.notEqual(rejectedRegistration.status, 200, "server accepted registration without UV");
  const registrationReplay = await postResponse(
    "/api/auth/passkey/verify-registration",
    registration.cookie,
    { response: noUvRegistration, createSession: true, name: "Negative UV passkey" },
  );
  assert.notEqual(registrationReplay.status, 200, "consumed registration challenge was replayable");
  const pendingUserId = registration.body.user.id as string;
  assert.equal(
    await ctx.internalAdapter.findUserById(pendingUserId),
    null,
    "missing-UV registration created an account",
  );

  const syntheticUser = await ctx.internalAdapter.createUser({
    id: "step8-negative-user",
    name: "Step 8 Negative User",
    email: undefined as unknown as string,
    emailVerified: false,
  }, { method: "passkey" });
  assert.equal(syntheticUser.id, "step8-negative-user");
  await (ctx.adapter as any).create({
    model: "passkey",
    data: {
      name: "Synthetic security fixture",
      userId: syntheticUser.id,
      credentialID: credentialIdB64u,
      publicKey: Buffer.from(cosePublicKey).toString("base64"),
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
      transports: "internal",
      createdAt: new Date(),
      aaguid: "00000000-0000-0000-0000-000000000000",
    },
  });

  const authNoUv = await getOptions("/api/auth/passkey/generate-authenticate-options");
  const noUvAuthentication = authenticationResponse(authNoUv.body.challenge, false, 1);
  const controlAuthentication = await verifyAuthenticationResponse({
    response: noUvAuthentication,
    expectedChallenge: authNoUv.body.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: credentialIdB64u,
      publicKey: Buffer.from(cosePublicKey),
      counter: 0,
    },
    requireUserVerification: false,
  });
  assert.equal(controlAuthentication.verified, true, "authentication fixture is invalid apart from UV");
  const rejectedAuthentication = await postResponse(
    "/api/auth/passkey/verify-authentication",
    authNoUv.cookie,
    { response: noUvAuthentication },
  );
  assert.notEqual(rejectedAuthentication.status, 200, "server accepted authentication without UV");

  const authValid = await getOptions("/api/auth/passkey/generate-authenticate-options");
  const validAuthentication = authenticationResponse(authValid.body.challenge, true, 1);
  const accepted = await postResponse(
    "/api/auth/passkey/verify-authentication",
    authValid.cookie,
    { response: validAuthentication },
  );
  assert.equal(accepted.status, 200, "UV-valid authentication was rejected");

  const replay = await postResponse(
    "/api/auth/passkey/verify-authentication",
    authValid.cookie,
    { response: validAuthentication },
  );
  assert.notEqual(replay.status, 200, "consumed authentication challenge was replayable");
  console.log("PASS passkey registration/authentication reject missing UV and authentication challenge replay");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
