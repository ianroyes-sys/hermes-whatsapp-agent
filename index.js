// Hermes — personal WhatsApp assistant using the configured local read-only AI backend.
// Links to your WhatsApp like a "Linked Device" (same as WhatsApp Web), then answers
// messages you send to yourself (the "Message yourself" chat) by calling the local
// Claude Code CLI (claude.ai login) by default; HERMES_MODEL_BACKEND=codex selects Codex.
// No separate API key is added.
//
// Phone → Mac task gateway (integrated with Omega's vault pipeline):
//   /run <task>    — execute NOW via the read-only backend (web+read tools), result texted back
//                    and saved with an honest result receipt in Outputs/Hermes
//   /queue <task>  — drop into 20_Tasks/Midnight for Omega's 1am overnight run
//   /status        — queue + last completed + latest brief
//   /brief         — read today's Morning Brief
//   voice notes    — transcribed locally (whisper.cpp) and routed like text

const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  jidNormalizedUser,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// config.json is your local copy (gitignored); config.example.json is the committed default.
const CONFIG_FILE = [path.join(__dirname, "config.json"), path.join(__dirname, "config.example.json")].find((f) => fs.existsSync(f));
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
// HERMES_ALLOW_FROM (comma-separated numbers with country code) overrides config.allowFrom.
if (process.env.HERMES_ALLOW_FROM) config.allowFrom = process.env.HERMES_ALLOW_FROM.split(",").map((n) => n.trim()).filter(Boolean);
config.allowFrom = config.allowFrom || [];
const OWNER = process.env.HERMES_OWNER_NAME || config.ownerName || "the owner";
const vaultContext = require("./vault-context");
const { RESULT_SCHEMA, recordResult, resultLabel } = require("./task-result");
const { runModel } = require("./model-runner");
const dispatchSpool = require("./dispatch-spool");
const MODEL_BACKEND = process.env.HERMES_MODEL_BACKEND || "claude";
if (!["codex", "claude"].includes(MODEL_BACKEND)) throw new Error("Unsupported HERMES_MODEL_BACKEND");
const DATA_DIR = path.join(__dirname, "data");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const ACTIVITY_FILE = path.join(DATA_DIR, "activity.json");
const EVENTS_FILE = path.join(DATA_DIR, "events.ndjson");
const DISPATCH_INBOX = path.join(DATA_DIR, "dispatch-inbox");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(DISPATCH_INBOX, { recursive: true });

// ---------- live telemetry for the Omega Tower ----------

let activity = { heartbeat: Date.now(), running: null, connected: false, pairingRequired: false };
function writeActivity(patch) {
  activity = { ...activity, ...patch, heartbeat: Date.now() };
  try {
    fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(activity));
  } catch {}
}
writeActivity({}); // Replace stale connection telemetry immediately at process startup.
setInterval(() => writeActivity({}), 30_000);

function logEvent(type, text, agent = null) {
  try {
    fs.appendFileSync(EVENTS_FILE, JSON.stringify({ ts: Date.now(), type, text: String(text).slice(0, 200), agent }) + "\n");
  } catch {}
}
// keep the event log from growing forever
try {
  const lines = fs.readFileSync(EVENTS_FILE, "utf8").trim().split("\n");
  if (lines.length > 400) fs.writeFileSync(EVENTS_FILE, lines.slice(-300).join("\n") + "\n");
} catch {}

// ---------- Omega vault integration (same conventions as omega/scripts) ----------

const VAULT = vaultContext.VAULT;
const MIDNIGHT = path.join(VAULT, "20_Tasks/Midnight");
const RESULTS = path.join(VAULT, "Outputs/Hermes");
const BRIEFS = path.join(VAULT, "Cadence/Briefs");
const INBOX = path.join(VAULT, "10_Inbox");
// Tool surface lives in model-runner.js: read-only file tools plus web search, no writes.

// The LifeOS agents in the vault's .claude/agents, reachable from the phone.
// `communications` is deliberately absent — it's the only agent that can SEND,
// and every send stays gated behind the owner's approval in the vault, not a text.
const AGENTS = {
  school: { name: "school-agent", desc: "coursework, deadlines, resume, internships/scholarships/fellowships" },
  creative: { name: "creative-agent", desc: "personal brand — newsletter, video series, content calendar" },
  business: { name: "business-agent", desc: "agency and client work, app ventures, pricing" },
  research: { name: "researcher", desc: "fan-out fact gathering, returns findings with sources" },
  verify: { name: "verifier", desc: "skeptical pass over finished work before it reaches you" },
  devil: { name: "devils-advocate", desc: "the strongest case against your current plan" },
  scribe: { name: "scribe", desc: "briefs, logs, and vault memory upkeep" },
};
const AGENT_ALIASES = {
  "devils-advocate": "devil", da: "devil", devils: "devil",
  "school-agent": "school", "creative-agent": "creative", "business-agent": "business",
  researcher: "research", verifier: "verify", research2: "research",
};
const resolveAgent = (k) => {
  const key = String(k || "").toLowerCase().replace(/^\//, "");
  return AGENTS[key] ? key : AGENT_ALIASES[key] || null;
};
const AGENT_ROSTER = Object.entries(AGENTS)
  .map(([k, a]) => `- ${a.name} (/${k}) — ${a.desc}`)
  .join("\n");
const TASK_TIMEOUT_MS = (config.taskTimeoutMinutes || 12) * 60 * 1000;
const AGENT_TIMEOUT_MS = (config.agentTimeoutMinutes || 20) * 60 * 1000;
const REPLY_MAX = 3500;

// ---------- local voice transcription (whisper.cpp, all free/on-device) ----------

const TOOLS_DIR = process.env.HERMES_TOOLS_DIR || path.join(os.homedir(), "Developer/tools");
const FFMPEG = config.ffmpegPath || path.join(TOOLS_DIR, "bin/ffmpeg");
const WHISPER = config.whisperPath || path.join(TOOLS_DIR, "whisper.cpp/build/bin/whisper-cli");
const WHISPER_MODEL = config.whisperModel || path.join(TOOLS_DIR, "whisper.cpp/models/ggml-base.en.bin");
const voiceReady = () => [FFMPEG, WHISPER, WHISPER_MODEL].every((p) => fs.existsSync(p));

function systemPrompt() {
  return `You are ${config.botName}, the personal assistant of ${OWNER}, texting them over WhatsApp from their own Mac.

${operatingContract()}

You are wired into their second brain. You can read (never write) their Obsidian vault at ${VAULT} — your working directory — using Read, Glob and Grep. The vault's CLAUDE.md explains its structure. Omega, their dashboard at ${vaultContext.OMEGA}, runs off this same vault, so what you see is exactly what Omega shows them.

A live snapshot is below. Trust it for counts and status; use your tools to actually open a note when they ask about specifics. Never invent a note, task or deadline — if you can't find it, say so.

=== ${vaultContext.buildContext()}
===

If they want real work done, remind them they can dispatch to their LifeOS agents from the phone:
${AGENT_ROSTER}
"/run <task>" picks the right agent automatically and texts the result back; "/<agent> <task>" forces one; "/agents" lists them; "/queue <task>" schedules for Omega's 1am run; "/note <thought>" captures to their inbox; "/status" and "/brief" check the pipeline. Voice notes work too. This reasoning interface returns answers and drafts saved in Outputs/Hermes. External actions use the existing authorized execution lane; do not request an already-granted approval again.

Write like a sharp, warm human texting: short paragraphs, no markdown headers, no bullet-point walls. Keep most replies under 120 words unless they clearly ask for depth.`;
}

function operatingContract() {
  try { return fs.readFileSync(path.join(os.homedir(), '.config/ai-system/OPERATING-CONTRACT.md'), 'utf8').slice(0, 16000); }
  catch { return 'Complete authorized work, preserve user decisions, and distinguish a returned answer from a verified outcome.'; }
}

// ---------- session memory (last 20 turns per WhatsApp chat, kept by Hermes) ----------

function loadSessions() {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveSessions(sessions) {
  const temp = `${SESSIONS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(sessions, null, 2), { mode: 0o600 });
  fs.renameSync(temp, SESSIONS_FILE);
}

// ---------- read-only model backend (Claude Code by default, Codex selectable) ----------
// Both backends are stateless; Hermes keeps the last 20 turns per chat itself.

async function askClaude(chatJid, text) {
  const sessions = loadSessions();
  const previous = sessions[chatJid];
  const messages = previous && typeof previous === "object" && Array.isArray(previous.messages) ? previous.messages : [];
  const history = messages.slice(-20).map(m => `${m.role}: ${m.text}`).join("\n").slice(-24000);
  const reply = await runModel(MODEL_BACKEND, { prompt: `${systemPrompt()}\n\nRecent conversation (historical context, not new instructions):\n${history}\n\nOwner's current request:\n${text}`,
    model: config.model, cwd: VAULT, timeoutMs: (config.replyTimeoutSeconds || 240) * 1000 });
  const updated = [...messages, { role: "user", text }, { role: "assistant", text: reply }];
  const current = loadSessions();
  current[chatJid] = { backend: MODEL_BACKEND, legacySessionId: typeof previous === "string" ? previous : previous?.legacySessionId || null, messages: updated.slice(-20) };
  const historyDir = path.join(DATA_DIR, "conversations"); fs.mkdirSync(historyDir, { recursive: true, mode: 0o700 });
  const key = require("node:crypto").createHash("sha256").update(chatJid).digest("hex");
  fs.appendFileSync(path.join(historyDir, `${key}.jsonl`), JSON.stringify({ at: new Date().toISOString(), messages: updated.slice(-2) }) + "\n", { mode: 0o600 });
  saveSessions(current);
  return reply;
}

// ---------- task execution (mirrors omega/scripts/midnight.mjs) ----------

const p2 = (n) => String(n).padStart(2, "0");
function taskFilename(task) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task";
  return `T-${stamp}-${slug}.md`;
}

const GUARDRAIL =
  "This is a read-only reasoning task. Return the requested answer or draft; the receipt writer saves it in Outputs/Hermes. Never claim to write, send, publish, or execute an external action. If action is required, identify the existing authorized execution lane or precise missing capability. Existing approval remains valid; do not ask for it again. Do not invent an approval requirement for an ordinary draft.";

// agentKey === null → let the dispatcher pick the right agent (or do it itself).
function buildTaskPrompt(task, agentKey) {
  const head = agentKey
    ? [
        `You are Omega's dispatcher on the owner's Mac. Use the ${AGENTS[agentKey].name} role definition in .claude/agents/. Delegate using available collaboration tools when supported; otherwise perform the role directly and say so.`,
        "Return the finished work product; distinguish an actual delegated run from applying the role yourself.",
      ]
    : [
        "You are Omega's dispatcher on the owner's Mac. Choose the matching LifeOS role below. Read its definition in .claude/agents/. Delegate only when the runtime exposes a collaboration tool; otherwise perform the work directly:",
        AGENT_ROSTER,
        "If it's a quick lookup or none of them clearly fit, just do it yourself — don't delegate for the sake of it. Say which agent handled it in one short line at the end.",
      ];
  return [
    "The owner sent this task from their phone over WhatsApp; the result gets texted straight back to them.",
    operatingContract(),
    ...head,
    `You're working inside their Obsidian vault (${VAULT}) — its CLAUDE.md is the router; read freely for context.`,
    GUARDRAIL,
    "Return the finished work product directly — polished, concrete, no preamble. If essential input is unavailable, state the precise blocker. Lead with the answer; keep it tight enough to read on a phone.",
    `Current state:\n${vaultContext.buildContext()}`,
    "Return the structured result requested by the CLI: status completed, blocked, or needs_input; result contains the finished answer; evidence contains only actual local artifact paths and SHA-256 hashes you checked. Empty evidence is valid for a text answer. Never claim an external action merely because a response exists.",
    `Task: ${task}`,
  ].join("\n\n");
}

async function executeTask(task, agentKey = null, source = "phone") {
  const agentName = agentKey ? AGENTS[agentKey].name : "auto";
  writeActivity({ running: { task: task.slice(0, 160), agent: agentName, source, since: Date.now() } });
  logEvent("run-start", task, agentName);
  const prompt = buildTaskPrompt(task, agentKey);
  const timeout = agentKey ? AGENT_TIMEOUT_MS : TASK_TIMEOUT_MS;
  // Pinned to config.dispatchModel, not inherited from any interactive session.
  // No agent-spawning tool is exposed, so the role is applied directly (read-only).
  let raw = "", processError = null;
  try {
    raw = await runModel(MODEL_BACKEND, { prompt, model: config.dispatchModel, cwd: VAULT, schema: RESULT_SCHEMA, timeoutMs: timeout });
  } catch (error) {
    // An interrupted delegated task may already have acted. Never blindly replay it.
    processError = error.message;
  }
  try {
    const result = recordResult({ root: RESULTS, task, agent: agentName, source,
      raw, processError, allowedRoots: [path.join(VAULT, "Outputs"), path.join(VAULT, "20_Tasks"), path.join(VAULT, "Projects")] });
    logEvent(`run-${result.status}`, task, agentName);
    vaultContext.invalidate();
    return result;
  } finally {
    writeActivity({ running: null });
  }
}

function queueTask(task) {
  fs.mkdirSync(MIDNIGHT, { recursive: true });
  const file = taskFilename(task);
  fs.writeFileSync(
    path.join(MIDNIGHT, file),
    `---\ncreated: ${new Date().toISOString()}\nsource: hermes\nstatus: queued\n---\n\n${task}\n`
  );
  logEvent("queued", task);
  vaultContext.invalidate();
  return file;
}

// Quick capture from the phone → 10_Inbox, where the vault's triage picks it up.
function captureNote(text) {
  fs.mkdirSync(INBOX, { recursive: true });
  const d = new Date();
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}${p2(d.getMinutes())}`;
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").slice(0, 7).join(" ") || "capture";
  const file = `${stamp} ${slug}.md`;
  fs.writeFileSync(
    path.join(INBOX, file),
    `---\ncaptured: ${d.toISOString()}\nsource: hermes-phone\n---\n\n${text.trim()}\n`
  );
  logEvent("note", text);
  vaultContext.invalidate();
  return file;
}

function listQueue() {
  try {
    return fs.readdirSync(MIDNIGHT).filter((f) => f.endsWith(".md") && !f.startsWith("_")).sort();
  } catch {
    return [];
  }
}

function latestFile(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith("_"));
    if (!files.length) return null;
    return files
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0].f;
  } catch {
    return null;
  }
}

function statusText() {
  let s;
  try {
    s = vaultContext.snapshot();
  } catch (e) {
    return `Couldn't read the vault: ${e.message}`;
  }
  const lane = (label, l) => (l.count ? `${label}: ${l.count} — ${l.titles.slice(0, 3).join("; ")}` : null);
  return [
    `📊 ${s.now}`,
    ``,
    `Inbox: ${s.inbox.count} to triage`,
    lane("Active", s.lanes.Active),
    lane("Queue", s.lanes.Queue),
    lane("Awaiting your approval", s.lanes.Pending_Approval),
    lane("Grants", s.lanes.Grants),
    `Midnight queue (1am): ${s.lanes.Midnight.count}${s.lanes.Midnight.count ? " — " + s.lanes.Midnight.titles.slice(0, 3).join("; ") : ""}`,
    ``,
    s.done.length ? `Recently done: ${s.done.slice(0, 3).join("; ")}` : "Recently done: nothing yet",
    s.latestBrief ? `Latest brief: ${s.latestBrief}` : "Latest brief: none",
    `Fleet: ${s.fleet} apps tracked`,
    `Voice notes: ${voiceReady() ? "ready 🎙️" : "not set up"}`,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

function briefText() {
  const f = latestFile(BRIEFS);
  if (!f) return "No Morning Brief yet — queue something with /queue and Omega writes one at 1am.";
  const raw = fs.readFileSync(path.join(BRIEFS, f), "utf8").replace(/^---[\s\S]*?---\s*/, "").trim();
  return `${f.replace(/\.md$/, "")}\n\n${raw}`;
}

function clip(text, max = REPLY_MAX) {
  return text.length <= max ? text : text.slice(0, max) + "\n\n…(trimmed — full text is in the vault)";
}

// ---------- voice notes → text (ffmpeg + whisper.cpp, local & free) ----------

function execFileP(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120_000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(stdout)
    );
  });
}

async function transcribeVoice(msg) {
  const buf = await downloadMediaMessage(msg, "buffer", {});
  const id = Date.now().toString(36);
  const ogg = path.join(DATA_DIR, `voice-${id}.ogg`);
  const wav = path.join(DATA_DIR, `voice-${id}.wav`);
  try {
    fs.writeFileSync(ogg, buf);
    await execFileP(FFMPEG, ["-y", "-i", ogg, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
    const out = await execFileP(WHISPER, ["-m", WHISPER_MODEL, "-f", wav, "-np", "--no-timestamps", "--language", "en"]);
    return out.trim().replace(/\s+/g, " ");
  } finally {
    for (const f of [ogg, wav]) fs.rmSync(f, { force: true });
  }
}

// Voice routing: "run …" now, "queue …" tonight, "note …" captures, an agent
// name ("school …", "devil's advocate …") dispatches to it, else chat.
function routeVoiceTranscript(t) {
  const m = t.match(
    /^(?:hey\s+)?(?:hermes|omega)?[,.!\s]*(run|do|execute|queue|tonight|schedule|note|capture|remember|school|creative|business|research|researcher|verify|verifier|devil['’]?s?\s*advocate|devil|scribe)\b[,.!\s]*(.*)$/i
  );
  if (!m || !m[2].trim()) return { kind: "chat", text: t };
  const verb = m[1].toLowerCase().replace(/['’]/g, "").replace(/\s+/g, "-");
  const text = m[2].trim();
  const agent = resolveAgent(verb.startsWith("devil") ? "devil" : verb);
  if (agent) return { kind: "run", agent, text };
  if (["run", "do", "execute"].includes(verb)) return { kind: "run", agent: null, text };
  if (["note", "capture", "remember"].includes(verb)) return { kind: "note", text };
  return { kind: "queue", text };
}

// ---------- message handling ----------

// One at a time so concurrent --resume calls don't fork the same session.
let queue = Promise.resolve();
function enqueue(job) {
  queue = queue.then(job, job);
  return queue;
}
// Long-running tasks execute on their own lane (no --resume, so no session-fork risk),
// keeping chat responsive while a /run is in flight.
let taskLane = Promise.resolve();
function enqueueTask(job) {
  taskLane = taskLane.then(job, job);
  return taskLane;
}

function extractText(msg) {
  const m = msg.message;
  if (!m) return null;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    null
  );
}

// WhatsApp now addresses some chats by LID instead of phone number, so the
// self-chat can arrive as either our phone JID or our LID.
function isAllowedChat(jid, fromMe, me) {
  if (jid === "status@broadcast" || jid.endsWith("@g.us")) return false;
  if (config.respondToSelfChat && fromMe && (jid === me.jid || (me.lid && jid === me.lid))) return true;
  const number = jid.split("@")[0];
  return !fromMe && config.allowFrom.some((n) => number.includes(String(n).replace(/\D/g, "")));
}

async function handleRun(sock, jid, task, agentKey = null) {
  const who = agentKey ? `handing this to ${AGENTS[agentKey].name}` : "routing this to the right agent";
  await sock.sendMessage(jid, { text: `${config.replyPrefix}⚡ On it — ${who}. This can take a few minutes; I'll text you the result.` });
  enqueueTask(async () => {
    try {
      const { output, file, status } = await executeTask(task, agentKey);
      if (output) {
        await sock.sendMessage(jid, { text: `${config.replyPrefix}${resultLabel(status)} — saved to Outputs/Hermes/${file}\n\n${clip(output)}` });
      } else {
        await sock.sendMessage(jid, { text: `${config.replyPrefix}❌ The model run did not return a result. The interrupted run is recorded in Outputs/Hermes/${file}; check that record before retrying.` });
      }
    } catch (err) {
      await sock.sendMessage(jid, { text: `${config.replyPrefix}❌ Task failed: ${err.message.slice(0, 200)}` });
    }
  });
}

async function handleCommand(sock, jid, trimmed) {
  const [cmd, ...rest] = trimmed.split(/\s+/);
  let arg = rest.join(" ").trim();
  const lower = cmd.toLowerCase();

  // /school <task>, /devil <task>, … dispatch straight to that vault agent.
  const direct = resolveAgent(lower);
  if (direct) {
    if (!arg) {
      await sock.sendMessage(jid, { text: `${config.replyPrefix}What should ${AGENTS[direct].name} work on? ${lower} <task>` });
      return true;
    }
    await handleRun(sock, jid, arg, direct);
    return true;
  }

  switch (lower) {
    case "/agents": {
      const lines = Object.entries(AGENTS).map(([k, a]) => `/${k} — ${a.name}\n   ${a.desc}`);
      await sock.sendMessage(jid, {
        text: `${config.replyPrefix}🤖 Your LifeOS agents (text "/school find fall scholarships" to dispatch):\n\n${lines.join("\n")}\n\n/run <task> picks the right one automatically.\nThis interface returns answers and drafts in Outputs/Hermes. External actions use their existing authorized execution lane.`,
      });
      return true;
    }
    case "/agent": {
      const [maybe, ...restArgs] = arg.split(/\s+/);
      const key = resolveAgent(maybe);
      if (!key) {
        await sock.sendMessage(jid, { text: `${config.replyPrefix}Unknown agent "${maybe || ""}". Try /agents to see the list.` });
        return true;
      }
      arg = restArgs.join(" ").trim();
      if (!arg) {
        await sock.sendMessage(jid, { text: `${config.replyPrefix}What should ${AGENTS[key].name} work on?` });
        return true;
      }
      await handleRun(sock, jid, arg, key);
      return true;
    }
    case "/new": {
      const sessions = loadSessions();
      delete sessions[jid];
      saveSessions(sessions);
      await sock.sendMessage(jid, { text: `${config.replyPrefix}Fresh start — I've cleared our conversation memory.` });
      return true;
    }
    case "/help":
      await sock.sendMessage(jid, {
        text: `${config.replyPrefix}I'm ${config.botName} — your phone line to the Mac. I read your whole Ideaverse vault, so just ask me what's going on.\n\n/run <task> — do it NOW, auto-routed to the right agent\n/school /creative /business /research /verify /devil /scribe <task> — dispatch to that agent\n/agents — what each one does\n/queue <task> — schedule for Omega's 1am run\n/note <thought> — capture to 10_Inbox\n/status — inbox, lanes, queue, latest activity\n/loops — every loop's health · /fire <slug> to run one\n/needs — everything blocked on you · /answer <loop> <reply>\n/brief — read the Morning Brief\n/new — fresh chat memory\n\n🎙️ Voice notes work too: "run…", "queue…", "note…", or an agent name like "school…".`,
      });
      return true;
    case "/note": {
      if (!arg) {
        await sock.sendMessage(jid, { text: `${config.replyPrefix}What should I capture? /note <thought>` });
        return true;
      }
      const file = captureNote(arg);
      await sock.sendMessage(jid, { text: `${config.replyPrefix}📥 Captured to 10_Inbox/${file}` });
      return true;
    }
    case "/run":
      if (!arg) {
        await sock.sendMessage(jid, { text: `${config.replyPrefix}Give me the task: /run <what you want done>` });
        return true;
      }
      await handleRun(sock, jid, arg);
      return true;
    case "/queue": {
      if (!arg) {
        await sock.sendMessage(jid, { text: `${config.replyPrefix}Give me the task: /queue <what to run at 1am>` });
        return true;
      }
      const file = queueTask(arg);
      await sock.sendMessage(jid, {
        text: `${config.replyPrefix}🌙 Queued for the 1am Omega run (${listQueue().length} in queue).\n20_Tasks/Midnight/${file}\nThe result lands in your Morning Brief.`,
      });
      return true;
    }
    case "/status":
      await sock.sendMessage(jid, { text: `${config.replyPrefix}${statusText()}` });
      return true;
    case "/brief":
      await sock.sendMessage(jid, { text: `${config.replyPrefix}${clip(briefText())}` });
      return true;
    // ── Omega loop-engine bridge (2026-07-25) ──────────────────────────────
    // Command the loop engine from the phone. Same three actions the /loops cards
    // expose, no more: see, answer, fire. The engine's own gates still apply — an
    // answer to a paused loop queues and waits, exactly as it does in the browser.
    case "/loops":
      await sock.sendMessage(jid, { text: `${config.replyPrefix}${clip(await loopsText())}` });
      return true;
    case "/needs":
      await sock.sendMessage(jid, { text: `${config.replyPrefix}${clip(await needsText())}` });
      return true;
    case "/answer": {
      // /answer <slug> <text…>  — reply to the loop that asked, and fire it
      const [slug, ...rest] = arg.split(/\s+/);
      const text = rest.join(" ").trim();
      if (!slug || !text) {
        await sock.sendMessage(jid, {
          text: `${config.replyPrefix}Usage: /answer <loop> <your answer>\nExample: /answer opportunity use my campus mailing address\nSee who's asking with /needs.`,
        });
        return true;
      }
      const r = await omegaPost({ action: "answer", slug, kind: "note", text });
      await sock.sendMessage(jid, {
        text: `${config.replyPrefix}${
          r.ok
            ? `✅ ${slug} got it${r.started ? " and is running now." : `, queued (${r.blockedBy || "will pick it up next run"}).`}`
            : `❌ Couldn't reach Omega — is it running on 4780? (${r.error || "no response"})`
        }`,
      });
      return true;
    }
    case "/forge": {
      // /forge <Name of Church> <https://their-site.com>  — queue a demo app build
      const url = (arg.match(/https?:\/\/\S+/) || [])[0];
      const name = arg.replace(url || "", "").trim();
      if (!name || !url) {
        await sock.sendMessage(jid, {
          text: `${config.replyPrefix}Usage: /forge <Name> <url>\nExample: /forge Mount Zion SDA https://mountzionsda.org\nThen it builds them a demo app and texts you when it compiles.`,
        });
        return true;
      }
      try {
        const qf = path.join(vaultContext.OMEGA, "data/forge-queue.json");
        const q = JSON.parse(fs.readFileSync(qf, "utf8"));
        q.orders.push({ name, url, status: "queued", queuedAt: new Date().toISOString(), via: "hermes" });
        fs.writeFileSync(qf, JSON.stringify(q, null, 2));
        const r = await omegaPost({ action: "run", slug: "app-forge" });
        await sock.sendMessage(jid, {
          text: `${config.replyPrefix}🔨 Queued ${name}.${r.ok ? " App Forge is building now — it'll take a while." : " Start it from the /loops page when you're ready."}`,
        });
      } catch (e) {
        await sock.sendMessage(jid, { text: `${config.replyPrefix}❌ Couldn't queue that: ${e.message}` });
      }
      return true;
    }
    case "/fire": {
      const slug = arg.trim().split(/\s+/)[0];
      if (!slug) {
        await sock.sendMessage(jid, { text: `${config.replyPrefix}Usage: /fire <loop slug>. List them with /loops.` });
        return true;
      }
      const r = await omegaPost({ action: "run", slug });
      await sock.sendMessage(jid, {
        text: `${config.replyPrefix}${r.ok ? `▶️ ${slug} started.` : `❌ ${r.error || "Omega didn't respond"}`}`,
      });
      return true;
    }
    default:
      return false;
  }
}

/* ── Omega bridge helpers ──
   Omega serves the loop engine on 127.0.0.1:4780 (launchd, production build). Hermes only
   ever talks to it over that local API — it never reads loops/ directly, so every gate the
   engine enforces (STOP, paused/, running) applies to a phone command too. */
const OMEGA_URL = process.env.OMEGA_URL || "http://127.0.0.1:4780";

/* Omega's gate went live 2026-08-08 (it had never been switched on, leaving every route open
   on the LAN). Its middleware accepts either the browser's `omega_key` cookie or this header —
   Hermes has no cookie jar, so it sends the header. Read from Omega's own .env.local so there
   is exactly one place the passcode lives; without it every command below returns HTTP 401. */
const OMEGA_KEY = (() => {
  if (process.env.OMEGA_KEY) return process.env.OMEGA_KEY;
  try {
    const env = fs.readFileSync(path.join(vaultContext.OMEGA, ".env.local"), "utf8");
    return /^OMEGA_KEY=(.*)$/m.exec(env)?.[1]?.trim() || "";
  } catch {
    return "";
  }
})();

const omegaHeaders = (extra = {}) =>
  OMEGA_KEY ? { ...extra, "x-omega-key": OMEGA_KEY } : extra;

async function omegaGet(pathname) {
  try {
    const r = await fetch(`${OMEGA_URL}${pathname}`, {
      headers: omegaHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    return r.ok ? await r.json() : { error: `HTTP ${r.status}` };
  } catch (e) {
    return { error: e.message };
  }
}

async function omegaPost(body) {
  try {
    const r = await fetch(`${OMEGA_URL}/api/loops`, {
      method: "POST",
      headers: omegaHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    return r.ok ? await r.json() : { error: `HTTP ${r.status}` };
  } catch (e) {
    return { error: e.message };
  }
}

async function loopsText() {
  const d = await omegaGet("/api/loops");
  if (d.error || !d.loops) return `Can't reach the loop engine (${d.error || "no data"}). Is Omega up on 4780?`;
  const icon = (s) =>
    ({ running: "🔵", ok: "🟢", idle: "⚪️", capped: "🟡", blocked: "🟠", timeout: "🟠", stale: "🔴", failed: "🔴", stopped: "⏸", disabled: "⏸", never: "⚫️" }[s] || "•");
  const lines = d.loops.map((l) => `${icon(l.status)} ${l.slug} — ${l.status}${l.runs ? ` (${l.runs} runs)` : ""}`);
  const running = d.loops.filter((l) => l.status === "running").length;
  return [
    `🔁 ${d.loops.length} loops · ${running} running${d.allStopped ? " · ⛔️ ALL HALTED" : ""}`,
    "",
    ...lines,
    "",
    "/fire <slug> to run one · /needs to see what's blocked on you",
  ].join("\n");
}

async function needsText() {
  const d = await omegaGet("/api/needs");
  if (d.error) return `Can't reach Omega (${d.error}).`;
  const items = d.items || [];
  if (!items.length) return "✨ Nothing is blocked on you. The whole system is clear.";
  const mark = { red: "🔴", amber: "🟡", info: "⚪️" };
  const top = items.slice(0, 12).map((i) => `${mark[i.urgency] || "•"} ${i.title}${i.loop ? `\n   → /answer ${i.loop.slug} <your answer>` : ""}`);
  return [
    `🔔 ${items.length} thing${items.length > 1 ? "s" : ""} waiting on you (${d.counts?.red ?? 0} urgent)`,
    "",
    ...top,
    items.length > 12 ? `\n…and ${items.length - 12} more on the dashboard.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function handleMessage(sock, msg, me) {
  const jid = jidNormalizedUser(msg.key.remoteJid || "");
  if (!jid || !isAllowedChat(jid, !!msg.key.fromMe, me)) {
    if (jid) console.log(`[skip] jid=${jid} fromMe=${!!msg.key.fromMe} (me=${me.jid} lid=${me.lid || "none"})`);
    return;
  }

  // Voice notes → transcribe locally, then route like text.
  if (msg.message?.audioMessage) {
    if (!voiceReady()) {
      await sock.sendMessage(jid, { text: `${config.replyPrefix}🎙️ I got your voice note but transcription isn't set up on the Mac yet.` });
      return;
    }
    let transcript;
    try {
      transcript = await transcribeVoice(msg);
    } catch (err) {
      await sock.sendMessage(jid, { text: `${config.replyPrefix}🎙️ Couldn't transcribe that (${err.message.slice(0, 120)}). Try again?` });
      return;
    }
    if (!transcript) {
      await sock.sendMessage(jid, { text: `${config.replyPrefix}🎙️ I couldn't make out any words in that one.` });
      return;
    }
    const route = routeVoiceTranscript(transcript);
    await sock.sendMessage(jid, { text: `${config.replyPrefix}🎙️ Heard: "${transcript}"` });
    if (route.kind === "run") return handleRun(sock, jid, route.text, route.agent || null);
    if (route.kind === "queue") {
      const file = queueTask(route.text);
      await sock.sendMessage(jid, {
        text: `${config.replyPrefix}🌙 Queued for the 1am Omega run (${listQueue().length} in queue).\n20_Tasks/Midnight/${file}`,
      });
      return;
    }
    if (route.kind === "note") {
      const file = captureNote(route.text);
      await sock.sendMessage(jid, { text: `${config.replyPrefix}📥 Captured to 10_Inbox/${file}` });
      return;
    }
    // fall through to chat with the transcript
    msg = { ...msg, message: { conversation: transcript } };
  }

  const text = extractText(msg);
  if (!text) return;
  if (text.startsWith(config.replyPrefix)) return; // it's Hermes' own reply — don't answer yourself

  const trimmed = text.trim();
  if (trimmed.startsWith("/") && (await handleCommand(sock, jid, trimmed))) return;

  console.log(`[${new Date().toLocaleTimeString()}] ${jid}: ${trimmed.slice(0, 80)}`);
  logEvent("chat", trimmed);
  await sock.sendPresenceUpdate("composing", jid).catch(() => {});
  try {
    const reply = await askClaude(jid, trimmed);
    await sock.sendMessage(jid, { text: config.replyPrefix + reply });
  } catch (err) {
    console.error("AI backend call failed:", err.message);
    await sock.sendMessage(jid, {
      text: `${config.replyPrefix}Sorry — I couldn't reach the AI service just now (${err.message.slice(0, 120)}). Try again in a minute.`,
    });
  } finally {
    await sock.sendPresenceUpdate("paused", jid).catch(() => {});
  }
}

// ---------- Tower dispatch inbox ----------
// Omega's Tower page drops {task, agent} JSON files here; we run them through
// the exact same pipeline as a phone /run and text the owner the result as well.

let currentSock = null;
let selfJid = null;

function processDispatchInbox() {
  // Leave queued bytes untouched until the account is connected.
  if (!currentSock || !selfJid) return;
  let files;
  try { files = fs.readdirSync(DISPATCH_INBOX).filter(f => f.endsWith(".json")); } catch { return; }
  for (const name of files.sort()) {
    let item;
    try { item = dispatchSpool.claim(DISPATCH_INBOX, name); } catch { continue; }
    if (!item) continue;
    const job = item.job;
    if (job.notify) {
      const text = String(job.notify).slice(0, 3000);
      const deliverySocket = currentSock, deliveryJid = selfJid;
      Promise.resolve().then(() => deliverySocket.sendMessage(deliveryJid, { text: `${config.replyPrefix}${text}` }))
        .then(() => { dispatchSpool.acknowledge(item); logEvent("ping-delivered", text, job.source || "omega"); })
        .catch(() => { logEvent("ping-delivery-uncertain", name, job.source || "omega"); });
      // On ambiguous failure the claim remains for reconciliation, never blind resend.
      continue;
    }
    const task = String(job.task || "").trim();
    if (!task) { fs.renameSync(item.path, item.path + ".invalid"); continue; }
    const agentKey = resolveAgent(job.agent) || null;
    logEvent("dispatch-claimed", task, agentKey ? AGENTS[agentKey].name : "auto");
    enqueueTask(async () => {
      try {
        const { output, file, status } = await executeTask(task, agentKey, "dispatch");
        const who = agentKey ? AGENTS[agentKey].name : "auto-routed";
        const notice = `Dispatch (${who}): ${resultLabel(status)} — Outputs/Hermes/${file}\n\n${clip(output || "The run returned no result.", 1200)}`;
        dispatchSpool.queueResult(item, notice);
      } catch (error) {
        logEvent("dispatch-uncertain", `${name}: ${error.message.slice(0, 160)}`);
        // Preserve the claimed request; a crash/failure does not prove nothing acted.
      }
    });
  }
}
setInterval(processDispatchInbox, 5000);

// ---------- WhatsApp connection ----------

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, "auth"));
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    browser: ["Hermes", "Chrome", "1.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentSock = null; selfJid = null;
      writeActivity({ connected: false, pairingRequired: true });
      console.log("\nScan this QR with WhatsApp on your phone:");
      console.log("  WhatsApp → Settings → Linked Devices → Link a Device\n");
      qrcode.generate(qr, { small: true });
    }
    if (connection === "open") {
      currentSock = sock;
      selfJid = jidNormalizedUser(sock.user?.id || "");
      writeActivity({ connected: true, pairingRequired: false });
      logEvent("online", "Hermes connected to WhatsApp");
      console.log(`me: id=${sock.user?.id} lid=${sock.user?.lid || "none"} name=${sock.user?.name || ""}`);
      console.log(`\n✅ ${config.botName} is connected to WhatsApp.`);
      console.log(`Open WhatsApp, go to your own chat ("Message yourself"), and text ${config.botName}.\n`);
      if (process.env.HERMES_LINK_MODE) {
        console.log("Link complete — handing off to the background agent…");
        setTimeout(() => process.exit(0), 3000);
      }
    }
    if (connection === "close") {
      // An old socket must not clear a newer connection that already opened.
      if (currentSock && currentSock !== sock) return;
      currentSock = null; selfJid = null;
      writeActivity({ connected: false });
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log("Logged out of WhatsApp. Run `npm run logout`, then `npm start` to re-link.");
        process.exit(1);
      }
      console.log(`Connection dropped (${code ?? lastDisconnect?.error?.message ?? "unknown"}) — reconnecting…`);
      setTimeout(start, 3000);
    }
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    const me = {
      jid: jidNormalizedUser(sock.user?.id || ""),
      lid: sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null,
    };
    for (const msg of messages) {
      enqueue(() => handleMessage(sock, msg, me).catch((e) => console.error("handler error:", e.message)));
    }
  });
}

console.log(`Starting ${config.botName}…`);
start();
