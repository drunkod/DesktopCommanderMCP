/**
 * Legacy negative-offset regression entrypoint.
 *
 * This file used to document a historical read_file bug by returning false
 * without setting a failing process exit code. Negative offsets are now
 * supported, so keep the filename for suite compatibility but delegate to the
 * executable behavior test and propagate its result correctly.
 */

import runNegativeOffsetTests from './test-negative-offset-readfile.js';

export default async function runTests() {
  return runNegativeOffsetTests();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests()
    .then((success) => {
      if (!success) process.exitCode = 1;
    })
    .catch((error) => {
      console.error('❌ Unhandled error:', error);
      process.exitCode = 1;
    });
}
