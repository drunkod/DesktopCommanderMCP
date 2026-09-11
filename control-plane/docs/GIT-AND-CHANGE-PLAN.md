# Git and change plan

## 1. New implementation repository

Repository root:

```text
~/Documents/RemoteMCP-Jazz/implementation/
```

This is the only new Git repository we initialise now. It owns:

- the hosted MCP endpoint;
- Better Auth OAuth/device authorization;
- Jazz schema and permissions;
- dashboard/device administration;
- local/deployment scripts;
- shared protocol definitions.

Initial branch: `main`.

After the first clean local check/build, create feature branches from `main`
for changes rather than developing indefinitely on `main`.

Suggested first branch after baseline:

```bash
git switch -c feat/control-plane-mvp
```
## 2. Existing DesktopCommanderMCP repository

Repository root:

```text
~/Documents/RemoteMCP-Jazz/repositories/DesktopCommanderMCP/
```

Do **not** initialise Git here: it is already the `drunkod/DesktopCommanderMCP`
fork with `upstream` configured.

We will make the device-agent implementation here after the control plane is
green. Start from an up-to-date `main` and create:

```bash
git switch main
git fetch origin upstream
git pull --ff-only origin main
git switch -c feat/jazz-remote-device
```

Files expected to change are concentrated under:

```text
src/remote-device/
src/npm-scripts/remote.ts
package.json
```

The local Desktop Commander MCP tool implementation outside the remote-device
layer should remain untouched unless integration requires a narrow change.
## 3. Existing Jazz debugging repository

Repository root:

```text
~/Documents/work/jazz-tools-mcp-v2/
```

Do **not** initialise Git here either. It already tracks your fork and upstream.
Use it only when a failing control-plane/device test points to Jazz itself.

If a Jazz change is required, create a dedicated branch such as:

```bash
git switch main
git switch -c debug/remote-mcp-jazz
```

Keep Jazz fixes separate from application work. This lets us distinguish:

- an application/protocol bug;
- a Jazz API misunderstanding;
- an actual Jazz runtime/permission bug.

## 4. Umbrella folder

`~/Documents/RemoteMCP-Jazz/` remains a non-Git umbrella containing research,
plans, archives and the implementation/repository working copies. Do not run
`git init` at that umbrella level; nested repositories would make history and
review unnecessarily confusing.
