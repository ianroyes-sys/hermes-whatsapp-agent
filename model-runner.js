// Read-only phone reasoning backends (Claude Code by default, Codex selectable).
// Never retries with more authority and never replays an interrupted run.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

// Read-only tool surface: the Codex lane ran a read-only sandbox with web_search="live"
// for both chat and dispatch, so Claude gets file reads plus web search/fetch, and no
// write, shell, agent-spawning, or MCP tools.
const CLAUDE_READ_ONLY_TOOLS = 'Read,Glob,Grep,WebSearch,WebFetch';
const CLAUDE_TIERS = new Set(['haiku', 'sonnet', 'opus']);
// Reverse of Omega's Codex routes, so an explicit Codex model name keeps its tier.
const CODEX_TO_CLAUDE = { 'gpt-5.6-luna': 'haiku', 'gpt-5.6-terra': 'sonnet', 'gpt-6-astra': 'opus' };
const TIMEOUT_MESSAGE = 'Read-only model request timed out; not automatically replayed.';

function codexArgs({ cwd, model, output, schemaFile }) {
  const args = ['exec', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', cwd,
    '--model', model, '-c', 'approval_policy="never"', '-c', 'project_doc_max_bytes=0', '-c', 'web_search="live"',
    '--output-last-message', output];
  if (schemaFile) args.push('--output-schema', schemaFile);
  return [...args, '-'];
}

function resolveClaudeModel(model = 'sonnet') {
  if (CLAUDE_TIERS.has(model) || /^claude-/.test(model)) return model;
  if (CODEX_TO_CLAUDE[model]) return CODEX_TO_CLAUDE[model];
  throw new Error(`No Claude model mapping for "${model}"; use haiku, sonnet, opus, or a claude-* id.`);
}

// Prompt goes on stdin. --setting-sources "" skips the user's own hooks (SessionEnd capture),
// plugins and permission rules; dontAsk denies anything outside the explicit tool list.
function claudeArgs({ model, schema, tools = CLAUDE_READ_ONLY_TOOLS }) {
  const args = ['-p', '--model', model, '--output-format', 'json',
    '--tools', tools, '--allowedTools', tools, '--permission-mode', 'dontAsk',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
    '--disable-slash-commands', '--no-session-persistence'];
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  return args;
}

// Spawn one read-only child, feed the prompt on stdin, kill the whole group on timeout.
function runChild({ command, args, cwd, env, prompt, timeoutMs, spawnProcess, captureStdout, label }) {
  let timer, escalation;
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args,
      { cwd, detached: true, stdio: ['pipe', captureStdout ? 'pipe' : 'ignore', 'pipe'], env });
    let stdout = '', stderr = '', timedOut = false;
    const kill = signal => { if (child.pid) { try { process.kill(-child.pid, signal); } catch {} } };
    timer = setTimeout(() => {
      timedOut = true; kill('SIGTERM');
      escalation = setTimeout(() => { kill('SIGKILL'); reject(new Error(TIMEOUT_MESSAGE)); }, 1000);
    }, timeoutMs);
    if (captureStdout && child.stdout) child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.stdin.on('error', () => {});
    child.once('error', reject);
    child.once('close', code => {
      if (timedOut) { kill('SIGKILL'); reject(new Error(TIMEOUT_MESSAGE)); }
      else if (code !== 0) reject(new Error(stderr || stdout.slice(-2000) || `${label} exited ${code}`));
      else resolve(stdout);
    });
    child.stdin.end(prompt);
  }).finally(() => { clearTimeout(timer); clearTimeout(escalation); });
}

async function runCodex({ prompt, model = 'sonnet', cwd, schema, timeoutMs = 240000, env = process.env, spawnProcess = spawn }) {
  // Tier names (haiku/sonnet/opus) resolve through Omega's model map when it is installed;
  // without Omega, the model name is passed to Codex unchanged.
  let resolvedModel = model;
  try {
    const omegaDir = env.OMEGA_DIR || path.join(os.homedir(), 'Developer/omega');
    const router = await import(pathToFileURL(path.join(omegaDir, 'scripts/model-routing.mjs')).href);
    resolvedModel = router.resolveModel(model, env);
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-model-'));
  const output = path.join(dir, 'result.txt');
  const schemaFile = schema ? path.join(dir, 'schema.json') : null;
  if (schemaFile) fs.writeFileSync(schemaFile, JSON.stringify(schema), { mode: 0o600 });
  try {
    await runChild({ command: env.HERMES_CODEX_BIN || path.join(os.homedir(), '.npm-global/bin/codex'),
      args: codexArgs({ cwd, model: resolvedModel, output, schemaFile }), cwd, env, prompt, timeoutMs,
      spawnProcess, captureStdout: false, label: 'Codex' });
    if (!fs.existsSync(output)) throw new Error('Codex returned no final response.');
    const result = fs.readFileSync(output, 'utf8').trim();
    if (!result) throw new Error('Codex returned an empty final response.');
    return result;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Returns the reply text, or (with a schema) the structured object as a JSON string.
async function runClaude({ prompt, model = 'sonnet', cwd, schema, timeoutMs = 240000, env = process.env, spawnProcess = spawn }) {
  const childEnv = { ...env, IDEAVERSE_SESSION_CAPTURE: '1' };
  const stdout = await runChild({ command: env.HERMES_CLAUDE_BIN || path.join(os.homedir(), '.local/bin/claude'),
    args: claudeArgs({ model: resolveClaudeModel(model), schema }), cwd, env: childEnv, prompt, timeoutMs,
    spawnProcess, captureStdout: true, label: 'Claude' });
  let envelope;
  try { envelope = JSON.parse(stdout); } catch { throw new Error('Claude returned non-JSON output.'); }
  if (!envelope || envelope.is_error) throw new Error(`Claude returned an error result${envelope?.result ? `: ${String(envelope.result).slice(0, 300)}` : '.'}`);
  if (schema) {
    if (!envelope.structured_output || typeof envelope.structured_output !== 'object') throw new Error('Claude returned no structured result.');
    return JSON.stringify(envelope.structured_output);
  }
  const result = typeof envelope.result === 'string' ? envelope.result.trim() : '';
  if (!result) throw new Error('Claude returned an empty final response.');
  return result;
}

function runModel(backend, options) {
  if (backend === 'claude') return runClaude(options);
  if (backend === 'codex') return runCodex(options);
  throw new Error('Unsupported HERMES_MODEL_BACKEND');
}

module.exports = { CLAUDE_READ_ONLY_TOOLS, codexArgs, claudeArgs, resolveClaudeModel, runCodex, runClaude, runModel };
