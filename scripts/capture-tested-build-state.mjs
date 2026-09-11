#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const MAX_OUTPUT = 128 * 1024 * 1024;
const desktopRoot = gitTopLevel(process.cwd());
const implementationRoot = process.env.DC_CONTROL_PLANE_REPO
  ? path.resolve(process.env.DC_CONTROL_PLANE_REPO)
  : path.resolve(desktopRoot, "..", "..", "implementation");
const parsed = parseArgs(process.argv.slice(2));
const outputPath = path.resolve(
  parsed.output ?? path.join(desktopRoot, "docs", "PASSKEY-TESTED-BUILD-MANIFEST.json"),
);
const startedAtUtc = parsed.startedAt ?? new Date().toISOString();

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runBuffer(command, args, cwd, allowFailure = false) {
  const result = spawnSync(command, args, { cwd, maxBuffer: MAX_OUTPUT });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}`);
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? Buffer.alloc(0) };
}
function runText(command, args, cwd, allowFailure = false) {
  const result = runBuffer(command, args, cwd, allowFailure);
  return { status: result.status, text: result.stdout.toString("utf8").trim() };
}

function gitTopLevel(cwd) {
  const result = runText("git", ["rev-parse", "--show-toplevel"], cwd);
  return result.text;
}

function parseArgs(args) {
  const result = { output: null, startedAt: null, verify: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--verify") result.verify = true;
    else if (arg === "--output") result.output = args[++index];
    else if (arg === "--started-at") result.startedAt = args[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function relativeIfInside(root, candidate) {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

function isSensitiveUntracked(relativePath) {
  const base = path.posix.basename(relativePath);
  return /^\.env(?:\.|$)/.test(base) && base !== ".env.example";
}
function hashPath(fullPath) {
  const info = lstatSync(fullPath);
  if (info.isSymbolicLink()) {
    return { kind: "symlink", bytes: info.size, sha256: sha256(readlinkSync(fullPath)) };
  }
  if (!info.isFile()) throw new Error(`Unsupported untracked path type: ${fullPath}`);
  return { kind: "file", bytes: info.size, sha256: sha256(readFileSync(fullPath)) };
}

function readJsonIfPresent(filePath) {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath);
  const parsedJson = JSON.parse(raw.toString("utf8"));
  return {
    path: path.basename(filePath),
    sha256: sha256(raw),
    name: parsedJson.name ?? null,
    version: parsedJson.version ?? null,
    packageManager: parsedJson.packageManager ?? null,
  };
}

function gitHead(root) {
  const result = runText("git", ["rev-parse", "--verify", "HEAD"], root, true);
  return result.status === 0 ? result.text : null;
}

function gitBranch(root) {
  return runText("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], root, true).text || null;
}

function splitNul(buffer) {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}
function captureRepository(root, evidenceExclusions) {
  const status = runText("git", ["status", "--short", "--untracked-files=all"], root).text;
  const staged = runBuffer("git", ["diff", "--cached", "--binary", "--no-ext-diff", "--"], root).stdout;
  const unstaged = runBuffer("git", ["diff", "--binary", "--no-ext-diff", "--"], root).stdout;
  const rawUntracked = splitNul(
    runBuffer("git", ["ls-files", "--others", "--exclude-standard", "-z"], root).stdout,
  ).sort();

  const untrackedFiles = [];
  const excludedEvidenceFiles = [];
  for (const relativePath of rawUntracked) {
    if (evidenceExclusions.has(relativePath)) {
      excludedEvidenceFiles.push(relativePath);
      continue;
    }
    if (isSensitiveUntracked(relativePath)) {
      throw new Error(`Refusing to hash sensitive untracked file: ${relativePath}`);
    }
    untrackedFiles.push({ path: relativePath, ...hashPath(path.join(root, relativePath)) });
  }

  const lockfiles = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "flake.lock"]
    .filter((name) => existsSync(path.join(root, name)))
    .map((name) => ({ name, sha256: sha256(readFileSync(path.join(root, name))) }));

  return {
    path: root,
    branch: gitBranch(root),
    head: gitHead(root),
    headState: gitHead(root) ? "committed" : "unborn",
    statusShort: status ? status.split("\n") : [],
    stagedPatchSha256: sha256(staged),
    unstagedPatchSha256: sha256(unstaged),
    untrackedFiles,
    excludedEvidenceFiles,
    lockfiles,
    package: readJsonIfPresent(path.join(root, "package.json")),
  };
}
function packageManagerFor(root) {
  const pkg = readJsonIfPresent(path.join(root, "package.json"));
  const declared = pkg?.packageManager?.split("@", 1)[0];
  if (declared) return declared;
  if (existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(root, "package-lock.json"))) return "npm";
  return null;
}

function nixShellVersion(root, command, args = []) {
  return runText("nix", ["develop", root, "-c", command, ...args], root).text;
}

function captureRuntime(root) {
  const packageManager = packageManagerFor(root);
  return {
    node: nixShellVersion(root, "node", ["--version"]),
    packageManager,
    packageManagerVersion: packageManager
      ? nixShellVersion(root, packageManager, ["--version"])
      : null,
    git: nixShellVersion(root, "git", ["--version"]),
    nix: runText("nix", ["--version"], root).text,
  };
}

function componentPackage(root, relativePath) {
  const fullPath = path.join(root, relativePath);
  if (!existsSync(fullPath)) return null;
  const raw = readFileSync(fullPath);
  const pkg = JSON.parse(raw.toString("utf8"));
  return {
    path: relativePath,
    sha256: sha256(raw),
    name: pkg.name ?? null,
    version: pkg.version ?? null,
    packageManager: pkg.packageManager ?? null,
  };
}
function captureManifest() {
  if (!existsSync(implementationRoot)) {
    throw new Error(`Control-plane workspace not found: ${implementationRoot}`);
  }
  const desktopExclusions = new Set(["TODO.md"]);
  const outputRelative = relativeIfInside(desktopRoot, outputPath);
  if (outputRelative) desktopExclusions.add(outputRelative);

  const repositories = {
    desktopCommander: captureRepository(desktopRoot, desktopExclusions),
    controlPlaneWorkspace: captureRepository(implementationRoot, new Set()),
  };
  repositories.controlPlaneWorkspace.components = [
    componentPackage(implementationRoot, "apps/control-plane/package.json"),
  ].filter(Boolean);

  const runtimes = {
    desktopCommander: captureRuntime(desktopRoot),
    controlPlaneWorkspace: captureRuntime(implementationRoot),
  };
  const fingerprintPayload = { repositories, runtimes };

  return {
    schemaVersion: "passkey-tested-build-state/v1",
    purpose: "Exact source/runtime fingerprint for passkey and Remote MCP validation",
    validationWindow: {
      startedAtUtc,
      endedAtUtc: new Date().toISOString(),
    },
    evidencePolicy: {
      excludedContentPaths: {
        desktopCommander: [...desktopExclusions].sort(),
        controlPlaneWorkspace: [],
      },
      note: "Evidence-file contents are excluded so recording results cannot mutate the tested source fingerprint; git status entries remain recorded.",
    },
    ...fingerprintPayload,
    buildFingerprintSha256: sha256(JSON.stringify(fingerprintPayload)),
  };
}
function main() {
  if (parsed.verify) {
    if (!existsSync(outputPath)) throw new Error(`Manifest not found: ${outputPath}`);
    const expected = JSON.parse(readFileSync(outputPath, "utf8"));
    const current = captureManifest();
    if (expected.buildFingerprintSha256 !== current.buildFingerprintSha256) {
      console.error("TESTED_BUILD_VERIFY=FAIL fingerprint mismatch");
      console.error(`expected=${expected.buildFingerprintSha256}`);
      console.error(`current=${current.buildFingerprintSha256}`);
      process.exitCode = 1;
      return;
    }
    console.log(`TESTED_BUILD_VERIFY=PASS ${current.buildFingerprintSha256}`);
    return;
  }

  const manifest = captureManifest();
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  console.log(`TESTED_BUILD_CAPTURE=PASS ${manifest.buildFingerprintSha256}`);
  console.log(`manifest=${outputPath}`);
}

try {
  main();
} catch (error) {
  console.error(`TESTED_BUILD_CAPTURE=FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
