import assert from 'node:assert/strict';
import {
  getSimilarityRatio,
  runFuzzySearch,
} from '../dist/tools/fuzzySearchCore.js';

const exact = 'unique_report_anchor_python_fuzzy = "original: Desktop Commander MCP handles files, commands, and edit blocks"';
const text = '# header\n' + exact + '\n' + 'unrelated filler text\n'.repeat(10000);
const expectedStart = text.indexOf(exact);

for (const query of [
  exact.replace('Commander', 'Comander'),
  exact.replace('unique_report', 'unique_reporx'),
]) {
  const { result } = runFuzzySearch(text, query);
  assert.equal(result.start, expectedStart);
  assert.equal(result.value, exact);
  assert.ok(
    getSimilarityRatio(query, result.value) > 0.95,
    'near-match should remain well above the edit_block fuzzy threshold',
  );
}

console.log('✓ fuzzy search localizes near-matches in large files');
