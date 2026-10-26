// Process completion, model reports and verified outcomes are separate facts.
// This module has no messaging, model, network, or task-execution side effects.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['completed', 'blocked', 'needs_input'] },
    result: { type: 'string', minLength: 1 },
    evidence: { type: 'array', maxItems: 20, items: {
      type: 'object', additionalProperties: false,
      properties: { path: { type: 'string' }, sha256: { type: 'string' } },
      required: ['path', 'sha256'],
    } },
  }, required: ['status', 'result', 'evidence'],
};

function parseResult(raw, processError = null) {
  if (processError) return { status: 'failed', reportedStatus: null, output: '', processOutcome: 'failed', error: String(processError).slice(0, 1000), evidenceClaims: [] };
  let data;
  try { data = JSON.parse(String(raw)); } catch {}
  if (data?.is_error === true) return parseResult('', 'Model CLI returned an error result.');
  const structured = data?.structured_output || (data?.status ? data : null);
  const valid = structured && ['completed', 'blocked', 'needs_input'].includes(structured.status)
    && typeof structured.result === 'string' && structured.result.trim()
    && Array.isArray(structured.evidence);
  const output = valid ? structured.result.trim() : typeof data?.result === 'string' ? data.result.trim() : String(raw || '').trim();
  if (!output) return parseResult('', 'Model CLI returned no result.');
  return {
    status: valid ? (structured.status === 'completed' ? 'reported_complete' : structured.status) : 'response_available',
    reportedStatus: valid ? structured.status : null,
    output, processOutcome: 'exited_zero', error: null,
    evidenceClaims: valid ? structured.evidence.slice(0, 20) : [],
  };
}

function inspectEvidence(claims, allowedRoots) {
  const roots = allowedRoots.flatMap(root => { try { return [fs.realpathSync(root)]; } catch { return []; } });
  return claims.map(claim => {
    if (!claim || typeof claim.path !== 'string' || !path.isAbsolute(claim.path)) return { status: 'rejected', reason: 'absolute-path-required' };
    let target;
    try { target = fs.realpathSync(claim.path); } catch { return { path: claim.path, status: 'missing' }; }
    if (!roots.some(root => target.startsWith(root + path.sep))) return { path: claim.path, status: 'rejected', reason: 'outside-evidence-roots' };
    // Do not hash credentials simply because the model names them as evidence.
    if (target.split(path.sep).some(part => part.startsWith('.') || /^(auth|credentials|secrets)$/i.test(part))) return { path: claim.path, status: 'rejected', reason: 'private-path' };
    try {
      const st = fs.statSync(target);
      if (!st.isFile() || st.size > 20 * 1024 * 1024) return { path: claim.path, status: 'rejected', reason: 'not-bounded-file' };
      if (typeof claim.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(claim.sha256)) return { path: claim.path, status: 'unverified', reason: 'missing-valid-hash' };
      const sha256 = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
      return { path: claim.path, status: sha256 === claim.sha256.toLowerCase() ? 'artifact_matched' : 'hash_mismatch', sha256, bytes: st.size };
    } catch { return { path: claim.path, status: 'unverified', reason: 'artifact-unreadable' }; }
  });
}

function recordResult({ root, task, agent, source, raw, processError, allowedRoots = [] }) {
  const result = parseResult(raw, processError);
  const evidence = inspectEvidence(result.evidenceClaims, allowedRoots);
  const id = `T-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(root, '.pending-'));
  const receipt = {
    schemaVersion: 1, id, at: new Date().toISOString(), source, agent,
    status: result.status, reportedStatus: result.reportedStatus,
    processOutcome: result.processOutcome,
    verificationStatus: 'unverified',
    verificationReason: 'A response or matching artifact does not independently establish task correctness.',
    evidence, outputSha256: crypto.createHash('sha256').update(result.output).digest('hex'),
    error: result.error,
  };
  try {
    fs.writeFileSync(path.join(staging, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(staging, 'result.md'), `---\nstatus: ${receipt.status}\nverification: ${receipt.verificationStatus}\nsource: hermes-run\n---\n\n## Request\n\n${task}\n\n## Result\n\n${result.output || '_No result returned._'}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(staging, path.join(root, id));
  } catch (error) { fs.rmSync(staging, { recursive: true, force: true }); throw error; }
  return { ...result, receipt, file: `${id}/result.md` };
}

function resultLabel(status) {
  return ({ reported_complete: 'Result ready', response_available: 'Response received', blocked: 'Task blocked', needs_input: 'Input needed', failed: 'Task failed' })[status] || 'Response received';
}

module.exports = { RESULT_SCHEMA, parseResult, inspectEvidence, recordResult, resultLabel };
