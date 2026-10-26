const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseResult, inspectEvidence, recordResult, resultLabel } = require('./task-result');

test('nonempty success prose never proves completion', () => {
  assert.equal(parseResult('Everything passed!').status, 'response_available');
  assert.equal(parseResult(JSON.stringify({ result: 'Everything passed!' })).status, 'response_available');
});
test('process failure overrides convincing success prose', () => {
  assert.equal(parseResult('Done', 'exit 1').status, 'failed');
  assert.equal(parseResult(JSON.stringify({ is_error: true, result: 'Done' })).status, 'failed');
});
test('structured report is preserved without converting it to verification', () => {
  for (const status of ['completed', 'blocked', 'needs_input']) {
    const result = parseResult(JSON.stringify({ structured_output: { status, result: 'A result', evidence: [] } }));
    assert.equal(result.reportedStatus, status);
    assert.equal(result.status, status === 'completed' ? 'reported_complete' : status);
  }
  assert.equal(parseResult('').status, 'failed');
});
test('evidence checker rejects escape, private paths, missing files and incorrect hashes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-result-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const allowed = path.join(root, 'allowed'); fs.mkdirSync(allowed);
  const artifact = path.join(allowed, 'report.md'); fs.writeFileSync(artifact, 'actual');
  const outside = path.join(root, 'outside.md'); fs.writeFileSync(outside, 'private');
  fs.symlinkSync(outside, path.join(allowed, 'escape.md'));
  fs.writeFileSync(path.join(allowed, '.env'), 'secret');
  const hash = crypto.createHash('sha256').update('actual').digest('hex');
  const claims = [{ path: artifact, sha256: hash }, { path: artifact, sha256: '0'.repeat(64) }, { path: path.join(allowed, 'escape.md'), sha256: hash }, { path: path.join(allowed, '.env'), sha256: hash }, { path: path.join(allowed, 'missing.md'), sha256: hash }, { path: artifact }];
  assert.deepEqual(inspectEvidence(claims, [allowed]).map(x => x.status), ['artifact_matched', 'hash_mismatch', 'rejected', 'rejected', 'missing', 'unverified']);
  assert.equal(inspectEvidence([{ path: artifact, sha256: [hash] }], [allowed])[0].status, 'unverified');
});
test('result persistence is exclusive and keeps result/receipt paired without a Done record', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const args = { root, task: 'Research this', agent: 'researcher', source: 'test', raw: JSON.stringify({ structured_output: { status: 'completed', result: 'Draft', evidence: [] } }) };
  const a = recordResult(args), b = recordResult(args);
  assert.notEqual(a.file, b.file);
  assert.equal(a.receipt.verificationStatus, 'unverified');
  assert.equal(fs.readFileSync(path.join(root, a.file), 'utf8').includes('status: done'), false);
  assert.equal(fs.readdirSync(root).length, 2);
  assert.equal(resultLabel(a.status), 'Result ready');
});
