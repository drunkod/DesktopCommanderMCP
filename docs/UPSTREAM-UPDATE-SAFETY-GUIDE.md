# Upstream Update Safety Guide

This repository uses two Git remotes:

- `origin` — your fork: `https://github.com/drunkod/DesktopCommanderMCP.git`
- `upstream` — original project: `https://github.com/wonderwhy-er/DesktopCommanderMCP.git`

The rule is simple: **fetch updates from `upstream`, push your work to `origin`.**

## What not to do

Do not use commands that overwrite your branch or rewrite published history unless you explicitly intend to recover or reset work.

Avoid these during normal synchronization:

```bash
git reset --hard upstream/main
git push --force
git push --force-with-lease
git rebase upstream/main
```

Also do not run `git pull` blindly on a feature branch. It may merge or rebase from whatever tracking branch is configured, which can make the history harder to understand.

Never push to `upstream`. This repository is configured with the upstream push URL disabled, but the intended workflow is still to treat upstream as read-only.

## Safe way to update `main`

Start from a clean working tree:

```bash
git status -sb
```

If you have uncommitted work, commit it or stash it before changing branches.

Then update the local view of both repositories:

```bash
git fetch upstream --prune --tags
git fetch origin --prune --tags
```

Switch to `main` and only fast-forward it:

```bash
git switch main
git merge --ff-only upstream/main
```

`--ff-only` is intentional. It refuses to create an unexpected merge commit if local `main` has diverged from upstream.

After verifying the result, mirror that update to your fork:

```bash
git push origin main
```

## Safe way to update your Jazz feature branch

After `main` is synchronized with upstream:

```bash
git switch feat/jazz-remote-device
git merge main
```

Prefer merging `main` into a published feature branch instead of rebasing it. This keeps existing commit IDs stable and avoids force-pushing rewritten history.

Resolve conflicts carefully if Git reports any. Do not use `--ours` or `--theirs` across the whole repository without reviewing each conflict.

After the merge, run the project gate:

```bash
nix develop -c just full-gate
```

Only push after tests pass:

```bash
git push origin feat/jazz-remote-device
```

## Before every upstream update

Check these four things:

1. `git status -sb` shows no unexpected local changes.
2. You know which branch you are currently on.
3. `git fetch upstream --prune --tags` has completed successfully.
4. You have inspected what upstream changed before merging it into important feature work.
