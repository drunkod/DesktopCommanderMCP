# Hands-on development handoff

You run commands and make requested edits on the Mac. I review the resulting
code/diffs and diagnose failures. We work in small, reviewable checkpoints.

## What to send after a failing command

Send the command you ran plus the first complete error block. For compiler
errors, include all errors for the first affected file. For runtime failures,
include the root-cause stack and the preceding 20–30 log lines.

Never send values from `.env.local`, OAuth refresh tokens, Jazz admin/backend
secrets, Keychain contents, or private keys.

## What to send after code changes

From the repository being changed:

```bash
git status --short
git diff --stat
git diff -- <files-you-changed>
```

If the diff is large, send one logical file at a time. I will assess API use,
security boundaries, failure semantics and whether the change belongs in that
repository before asking you to continue.

## Checkpoint rule

Do not combine control-plane, DesktopCommanderMCP and Jazz-library fixes in one
commit. Each repository must remain independently reviewable and revertible.
