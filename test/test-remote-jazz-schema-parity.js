import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootSchemaPath = path.resolve(here, '../src/remote-device/jazz-schema.ts');
const protocolSchemaPath = path.resolve(
  here,
  '../control-plane/packages/protocol/src/application-schema.ts',
);

function applicationSchemaBlock(file) {
  const source = fs.readFileSync(file, 'utf8').replaceAll(String.fromCharCode(13), '');
  const start = source.indexOf('export const applicationSchema = {');
  const end = source.indexOf('export const applicationOnlyApp', start);
  assert.notEqual(start, -1, 'applicationSchema start missing in ' + file);
  assert.notEqual(end, -1, 'applicationSchema end missing in ' + file);
  return source.slice(start, end).trimEnd();
}

assert.equal(
  applicationSchemaBlock(rootSchemaPath),
  applicationSchemaBlock(protocolSchemaPath),
  'root remote-device Jazz schema must exactly match the canonical protocol application schema',
);

console.log('remote Jazz application schema parity: ok');
