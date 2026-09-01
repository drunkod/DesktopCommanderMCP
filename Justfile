set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

default:
  @just --list

bootstrap:
  npm ci

check:
  npm run build

test:
  npm test

integration:
  npm run test:integration

validate-tools:
  npm run validate:tools

device:
  npm run device:start

status:
  git status --short
