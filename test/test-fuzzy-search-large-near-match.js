import assert from 'node:assert/strict';
import {
  getSimilarityRatio,
  runFuzzySearch,
} from '../dist/tools/fuzzySearchCore.js';

const exactTarget =
  'unique_report_anchor_python_fuzzy_25 = "original: Desktop Commander MCP handles files, commands, and edit blocks"';
const query = exactTarget.replace('Commander', 'Comander');

const filler = Array.from(
  { length: 1800 },
  (_, index) =>
    `def generated_${index}():\n    return "unrelated README-style filler line ${index} with commands and files"\n`,
).join('\n');

const text = [
  '# generated fixture',
  exactTarget,
  '',
  filler,
].join('\n');

const { result } = runFuzzySearch(text, query);
const similarity = getSimilarityRatio(query, result.value);

assert.equal(
  result.value,
  exactTarget,
  'large-file fuzzy search should not prune away the near-match near the beginning',
);
assert.ok(
  similarity >= 0.99,
  `expected a near-exact fuzzy candidate, got ${(similarity * 100).toFixed(1)}%`,
);

console.log('Fuzzy large-file near-match regression: ok');
