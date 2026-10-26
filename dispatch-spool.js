// Durable claims avoid losing notifications while disconnected or replaying uncertain tasks.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function validJob(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) return false;
  if (job.source !== undefined && typeof job.source !== 'string') return false;
  if (job.agent !== undefined && typeof job.agent !== 'string') return false;
  const task = typeof job.task === 'string' && job.task.trim().length > 0;
  const notify = typeof job.notify === 'string' && job.notify.trim().length > 0;
  if (job.task !== undefined && !task || job.notify !== undefined && !notify) return false;
  return Boolean(task) !== Boolean(notify);
}
function quarantine(file) {
  const base = file + '.invalid';
  for (;;) {
    const dest = fs.existsSync(base) ? base + '.' + crypto.randomUUID() : base;
    try { fs.linkSync(file, dest); fs.unlinkSync(file); return; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}
function claim(root, name) {
  if (path.basename(name) !== name || !name.endsWith('.json')) throw new Error('Invalid dispatch filename');
  const source = path.join(root, name), claimed = source + '.processing';
  try { fs.linkSync(source, claimed); } catch (error) { if (['ENOENT', 'EEXIST'].includes(error.code)) return null; throw error; }
  fs.unlinkSync(source);
  let job;
  try { job = JSON.parse(fs.readFileSync(claimed, 'utf8')); }
  catch { quarantine(claimed); return null; }
  if (!validJob(job)) { quarantine(claimed); return null; }
  return { root, name, path: claimed, job };
}
function acknowledge(item) { fs.unlinkSync(item.path); }
function queueResult(item, text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Result notification must contain text');
  const target = path.join(item.root, item.name.replace(/\.json$/, '.result-notify.json'));
  const content = JSON.stringify({ notify: text, source: 'hermes-result' })+'\n';
  // A previous attempt may have published a notice before the request was acked.
  // Never replace different bytes or recreate a notice already claimed for sending.
  const existing = [target + '.processing', target].find(file => fs.existsSync(file));
  if (existing) {
    if (fs.readFileSync(existing, 'utf8') !== content) throw new Error('Conflicting result notification; original request retained');
  } else {
    try { fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST' || fs.readFileSync(target, 'utf8') !== content) throw error;
    }
  }
  acknowledge(item);
}
module.exports = { claim, acknowledge, queueResult, validJob };
