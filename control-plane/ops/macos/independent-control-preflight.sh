#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="${REMOTE_MCP_ROOT:-$SCRIPT_ROOT}"
ATTESTATION_FILE="${REMOTE_MCP_INDEPENDENT_CONTROL_ATTESTATION:-$ROOT/.data/independent-control.attestation}"
MAX_AGE_SECONDS="${REMOTE_MCP_INDEPENDENT_CONTROL_MAX_AGE_SECONDS:-1800}"

repo_sha() {
  git -C "$ROOT" rev-parse HEAD
}

assert_not_remote_desktop_ancestry() {
  local cursor="$$"
  local command parent
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    command="$(ps -p "$cursor" -o command= 2>/dev/null || true)"
    if [[ "$command" == *"desktop-commander remote"       || "$command" == *"@wonderwhy-er/desktop-commander"       || "$command" == *"Remote_Desktop_Commander"       || "$command" == *"remote-desktop-commander" ]]; then
      echo "Remote Desktop Commander ancestry is not an independent control channel" >&2
      exit 1
    fi
    parent="$(ps -p "$cursor" -o ppid= 2>/dev/null | xargs)"
    [[ "$parent" =~ ^[0-9]+$ && "$parent" -gt 1 ]] || break
    cursor="$parent"
  done
}

write_attestation() {
  if [[ ! -t 0 || ! -t 1 ]]; then
    echo "independent control attestation requires an interactive TTY; this channel is not accepted" >&2
    exit 1
  fi
  assert_not_remote_desktop_ancestry

  local tty_path channel parent_pid parent_tty sha now tmp
  tty_path="$(tty)"
  [[ "$tty_path" == /dev/* ]] || { echo "unable to identify interactive TTY" >&2; exit 1; }
  if [[ -n "${SSH_CONNECTION:-}" ]]; then
    channel="ssh"
  else
    channel="local-terminal"
  fi

  parent_pid="$PPID"
  parent_tty="$(ps -p "$parent_pid" -o tty= | xargs)"
  [[ -n "$parent_tty" && "$parent_tty" != "??" && "$parent_tty" != "?" ]] || {
    echo "independent parent shell is not attached to a TTY" >&2
    exit 1
  }

  sha="$(repo_sha)"
  now="$(date +%s)"
  mkdir -p "$(dirname "$ATTESTATION_FILE")"
  tmp="$ATTESTATION_FILE.tmp.$$"
  {
    printf 'channel=%s\n' "$channel"
    printf 'verified_at_epoch=%s\n' "$now"
    printf 'repo_sha=%s\n' "$sha"
    printf 'session_pid=%s\n' "$parent_pid"
    printf 'tty=%s\n' "$tty_path"
  } >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ATTESTATION_FILE"
  echo "independent control attested: channel=$channel tty=$tty_path repo_sha=$sha"
  echo "keep this terminal/SSH session open through device stop, snapshot, activation, and rollback verification"
}

check_attestation() {
  [[ -f "$ATTESTATION_FILE" ]] || {
    echo "independent control attestation is missing: $ATTESTATION_FILE" >&2
    exit 1
  }

  local channel="" verified_at_epoch="" repo_sha_recorded="" session_pid="" tty_path=""
  while IFS='=' read -r key value; do
    case "$key" in
      channel) channel="$value" ;;
      verified_at_epoch) verified_at_epoch="$value" ;;
      repo_sha) repo_sha_recorded="$value" ;;
      session_pid) session_pid="$value" ;;
      tty) tty_path="$value" ;;
    esac
  done <"$ATTESTATION_FILE"

  [[ "$channel" == "ssh" || "$channel" == "local-terminal" ]] || {
    echo "invalid independent control channel in attestation" >&2
    exit 1
  }
  [[ "$verified_at_epoch" =~ ^[0-9]+$ ]] || { echo "invalid attestation timestamp" >&2; exit 1; }
  [[ "$session_pid" =~ ^[0-9]+$ ]] || { echo "invalid attestation session PID" >&2; exit 1; }
  [[ "$tty_path" == /dev/* ]] || { echo "invalid attestation TTY" >&2; exit 1; }

  local current_sha now age current_tty expected_tty
  current_sha="$(repo_sha)"
  [[ "$repo_sha_recorded" == "$current_sha" ]] || {
    echo "attestation repository SHA does not match current checkout" >&2
    exit 1
  }

  now="$(date +%s)"
  age=$((now - verified_at_epoch))
  (( age >= 0 && age <= MAX_AGE_SECONDS )) || {
    echo "independent control attestation is stale; run attest again from the independent terminal/SSH session" >&2
    exit 1
  }

  kill -0 "$session_pid" 2>/dev/null || {
    echo "independent control session PID is no longer alive" >&2
    exit 1
  }

  current_tty="$(ps -p "$session_pid" -o tty= | xargs)"
  expected_tty="${tty_path#/dev/}"
  [[ "$current_tty" == "$expected_tty" ]] || {
    echo "independent control session TTY no longer matches attestation" >&2
    exit 1
  }

  echo "independent control check: PASS channel=$channel tty=$tty_path age_seconds=$age repo_sha=$current_sha"
}

case "${1:-check}" in
  attest)
    write_attestation
    ;;
  check)
    check_attestation
    ;;
  clear)
    rm -f "$ATTESTATION_FILE"
    echo "independent control attestation cleared"
    ;;
  *)
    echo "usage: $0 [attest|check|clear]" >&2
    exit 2
    ;;
esac
