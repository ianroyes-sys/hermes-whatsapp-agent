const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { codexArgs, claudeArgs, resolveClaudeModel, CLAUDE_READ_ONLY_TOOLS } = require('./model-runner');

test('phone model cannot inherit write connectors or unrestricted execution', () => {
  const args = codexArgs({ cwd: '/tmp/task', model: 'explicit-model', output: '/tmp/result', schemaFile: '/tmp/schema' });
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('--output-schema'));
  assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.equal(args[args.indexOf('--model') + 1], 'explicit-model');
  assert.equal(args.at(-1), '-');
});

test('timeout settles even when a killed child never emits close; temp output is removed', async () => {
  const {runCodex}=require('./model-runner');const fs=require('node:fs');const path=require('node:path');
  let resultFile,launches=0;
  const spawnProcess=(command,args)=>{
    launches++;resultFile=args[args.indexOf('--output-last-message')+1];
    const child=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.end=()=>{};return child;
  };
  const started=Date.now();
  await assert.rejects(runCodex({prompt:'fixture',model:'gpt-6-astra',cwd:'/private/tmp',timeoutMs:10,spawnProcess}),/timed out.*not automatically replayed/);
  assert.equal(launches,1);assert.ok(Date.now()-started<3000);assert.equal(fs.existsSync(path.dirname(resultFile)),false);
});

test('claude backend is read-only: no write/shell/agent/MCP tools, no user hooks, no persisted session', () => {
  const schema = { type: 'object' };
  const args = claudeArgs({ model: 'sonnet', schema });
  const tools = args[args.indexOf('--tools') + 1].split(',');
  assert.deepEqual(tools.sort(), ['Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch']);
  for (const forbidden of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Task', 'Agent']) assert.equal(tools.includes(forbidden), false);
  assert.equal(args[args.indexOf('--allowedTools') + 1], CLAUDE_READ_ONLY_TOOLS);
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(args.includes('--bare'), false);
  assert.equal(args.includes('--dangerously-skip-permissions'), false);
  assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema') + 1]), schema);
  assert.equal(args.includes('--json-schema'), true);
  assert.equal(claudeArgs({ model: 'haiku' }).includes('--json-schema'), false);
  // Prompt travels on stdin, never argv.
  assert.equal(args[args.indexOf('-p') + 1], '--model');
});

test('claude model tiers keep the old Codex mapping', () => {
  assert.equal(resolveClaudeModel('haiku'), 'haiku');
  assert.equal(resolveClaudeModel('sonnet'), 'sonnet');
  assert.equal(resolveClaudeModel('gpt-5.6-terra'), 'sonnet');
  assert.equal(resolveClaudeModel('gpt-5.6-luna'), 'haiku');
  assert.equal(resolveClaudeModel('claude-opus-5-5'), 'claude-opus-5-5');
  assert.throws(() => resolveClaudeModel('mystery-model'), /No Claude model mapping/);
});

function fakeClaude(stdout, code = 0, seen = {}) {
  return (command, args, opts) => {
    Object.assign(seen, { command, args, opts });
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = new EventEmitter(); child.stdin.end = prompt => {
      seen.prompt = prompt;
      setImmediate(() => { child.stdout.emit('data', Buffer.from(stdout)); child.emit('close', code); });
    };
    return child;
  };
}

test('claude backend sends prompt on stdin, disables session capture, and returns structured output', async () => {
  const { runClaude } = require('./model-runner');
  const seen = {};
  const out = await runClaude({ prompt: 'fixture prompt', model: 'sonnet', cwd: '/private/tmp', schema: { type: 'object' }, timeoutMs: 5000,
    env: { HOME: '/tmp', PATH: '/usr/bin' }, spawnProcess: fakeClaude(JSON.stringify({ is_error: false, result: 'x', structured_output: { status: 'completed', result: 'done', evidence: [] } }), 0, seen) });
  assert.deepEqual(JSON.parse(out), { status: 'completed', result: 'done', evidence: [] });
  assert.equal(seen.prompt, 'fixture prompt');
  assert.equal(seen.args.includes('fixture prompt'), false);
  assert.equal(seen.opts.env.IDEAVERSE_SESSION_CAPTURE, '1');
  assert.equal(seen.opts.cwd, '/private/tmp');
});

test('claude backend returns chat text and rejects error envelopes', async () => {
  const { runClaude } = require('./model-runner');
  const base = { prompt: 'p', model: 'haiku', cwd: '/private/tmp', timeoutMs: 5000, env: {} };
  assert.equal(await runClaude({ ...base, spawnProcess: fakeClaude(JSON.stringify({ is_error: false, result: ' hi ' })) }), 'hi');
  await assert.rejects(runClaude({ ...base, spawnProcess: fakeClaude(JSON.stringify({ is_error: true, result: 'limit' })) }), /error result/);
  await assert.rejects(runClaude({ ...base, schema: {}, spawnProcess: fakeClaude(JSON.stringify({ is_error: false, result: 'x' })) }), /no structured result/);
  await assert.rejects(runClaude({ ...base, spawnProcess: fakeClaude('not json') }), /non-JSON/);
  await assert.rejects(runClaude({ ...base, spawnProcess: fakeClaude('', 1) }), /Claude exited 1/);
});
