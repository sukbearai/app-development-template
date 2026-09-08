import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const reports = {
  'test:e2e': { directory: 'app', file: 'result.json', mode: 'api', production: false },
  'test:ui': { directory: 'app', file: 'result.json', mode: 'ui', production: false },
  'test:ui:production': { directory: 'app', file: 'result.json', mode: 'ui', production: true },
  'test:capacity': { directory: 'app', file: 'result.json', mode: 'capacity', production: true },
  'test:containers': { directory: 'containers', file: 'summary.json' },
  'test:async-recovery': { directory: 'async-recovery', file: 'summary.json' },
  'test:kafka-security': { directory: 'kafka-security', file: 'summary.json' },
};
export async function validateGateReports(gate, files, root, source) {
  const expected = reports[gate];
  if (!expected) return;
  const matches = files.filter(file => path.relative(root, file).split(path.sep).join('/').startsWith(`.verification/${expected.directory}/`) && path.basename(file) === expected.file);
  assert.equal(matches.length, 1, `Expected one new ${gate} report`);
  const report = JSON.parse(await readFile(matches[0], 'utf8'));
  assert.equal(report.status, 'passed', `${gate} report failed`);
  assert.ok(!report.cleanupErrors?.length && !report.cleanupError, `${gate} cleanup failed`);
  if (expected.directory === 'app' || expected.directory === 'containers') assert.deepEqual(report.source, source, `${gate} source mismatch`);
  if (expected.mode) {
    assert.equal(report.mode, expected.mode, 'Wrong verification mode');
    assert.equal(report.production, expected.production, 'Wrong production surface');
  }
  if (expected.mode === 'ui') assert.equal(report.browserRuns, expected.production ? 2 : 1, 'Missing browser runs');
  if (expected.mode === 'capacity') {
    const capacity = JSON.parse(await readFile(path.join(path.dirname(matches[0]), 'capacity.json'), 'utf8'));
    assert.equal(capacity.status, 'passed', 'Capacity report failed');
    assert.deepEqual(capacity.comparison.source, source, 'Capacity source mismatch');
  }
}
