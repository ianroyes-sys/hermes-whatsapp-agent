// Live situation brief for Hermes — a cheap filesystem snapshot of the Ideaverse
// vault and Omega's pipeline, injected into every chat so Hermes knows what's
// actually going on without spending tool calls to find out. Read-only, cached.

const fs = require("fs");
const os = require("os");
const path = require("path");

const VAULT = process.env.VAULT_PATH || path.join(os.homedir(), "Developer/Ideaverse");
const OMEGA = process.env.OMEGA_DIR || path.join(os.homedir(), "Developer/omega");
const CACHE_MS = 60_000;

let cache = null;

const clean = (f) => f.replace(/\.md$/, "").replace(/^T-\d{8}-\d{6}-/, "");

function mdFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith("_") && !f.startsWith("."));
  } catch {
    return [];
  }
}

function newest(dir, n = 1) {
  return mdFiles(dir)
    .map((f) => {
      let m = 0;
      try {
        m = fs.statSync(path.join(dir, f)).mtimeMs;
      } catch {}
      return { f, m };
    })
    .sort((a, b) => b.m - a.m)
    .slice(0, n)
    .map((x) => x.f);
}

function body(file) {
  try {
    return fs.readFileSync(file, "utf8").replace(/^---[\s\S]*?---\s*/, "").trim();
  } catch {
    return "";
  }
}

function lane(name) {
  const files = mdFiles(path.join(VAULT, "20_Tasks", name));
  return { count: files.length, titles: files.slice(0, 6).map(clean) };
}

// Notes the owner actually touched lately — the best signal of "what's going on now".
function recentNotes(limit = 10) {
  const skipDirs = new Set([".obsidian", ".claude", ".smart-env", ".trash", ".git", "Templates", "Vector Index", "x"]);
  const skipTop = new Set(["20_Tasks", "Cadence"]); // reported separately
  const out = [];
  const cutoff = Date.now() - 10 * 86_400_000;
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || skipDirs.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth === 0 && skipTop.has(e.name)) continue;
        walk(full, depth + 1);
      } else if (e.name.endsWith(".md")) {
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs > cutoff) out.push({ rel: path.relative(VAULT, full).replace(/\.md$/, ""), m: st.mtimeMs });
        } catch {}
      }
    }
  };
  walk(VAULT, 0);
  return out.sort((a, b) => b.m - a.m).slice(0, limit).map((x) => x.rel);
}

function snapshot() {
  const inbox = mdFiles(path.join(VAULT, "10_Inbox"));
  const lanes = {
    Active: lane("Active"),
    Queue: lane("Queue"),
    Pending_Approval: lane("Pending_Approval"),
    Grants: lane("Grants"),
    Midnight: lane("Midnight"),
  };
  const doneDir = path.join(VAULT, "20_Tasks/Done");
  const briefsDir = path.join(VAULT, "Cadence/Briefs");
  const radarDir = path.join(VAULT, "Cadence/Radar");
  const resultDir = path.join(VAULT, "Outputs/Hermes");
  let results = [];
  try {
    results = fs.readdirSync(resultDir).filter(name => !name.startsWith('.')).sort().reverse().slice(0, 5)
      .flatMap(name => {
        try { const r = JSON.parse(fs.readFileSync(path.join(resultDir, name, 'receipt.json'), 'utf8'));
          return [{ id: name, status: r.status, verification: r.verificationStatus }]; } catch { return []; }
      });
  } catch {}

  const latestBriefFile = newest(briefsDir)[0];
  const brief = latestBriefFile ? body(path.join(briefsDir, latestBriefFile)).split("\n").slice(0, 6).join("\n") : "";

  let fleet = 0;
  try {
    fleet = JSON.parse(fs.readFileSync(path.join(OMEGA, "data/fleet.json"), "utf8")).length;
  } catch {}

  return {
    now: new Date().toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }),
    inbox: { count: inbox.length, titles: inbox.slice(0, 6).map(clean) },
    lanes,
    done: newest(doneDir, 5).map(clean),
    results,
    latestBrief: latestBriefFile ? clean(latestBriefFile) : null,
    briefExcerpt: brief,
    latestRadar: newest(radarDir, 2).map(clean),
    recent: recentNotes(),
    fleet,
  };
}

function buildContext() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.text;
  let s;
  try {
    s = snapshot();
  } catch (e) {
    return `(Vault snapshot unavailable: ${e.message})`;
  }

  const laneLine = (name, l) =>
    l.count ? `- ${name.replace("_", " ")} (${l.count}): ${l.titles.join("; ")}${l.count > l.titles.length ? "; …" : ""}` : null;

  const text = [
    `LIVE STATE — ${s.now}`,
    ``,
    `Inbox to triage: ${s.inbox.count}${s.inbox.count ? ` → ${s.inbox.titles.join("; ")}` : ""}`,
    `Open task lanes:`,
    laneLine("Active", s.lanes.Active),
    laneLine("Queue", s.lanes.Queue),
    laneLine("Pending Approval", s.lanes.Pending_Approval),
    laneLine("Grants", s.lanes.Grants),
    laneLine("Midnight queue (runs 1am)", s.lanes.Midnight),
    Object.values(s.lanes).every((l) => !l.count) ? "- all lanes empty" : null,
    ``,
    s.done.length ? `Previously recorded done (legacy labels): ${s.done.join("; ")}` : null,
    s.results.length ? `Recent phone results: ${s.results.map(r => `${r.id}: ${r.status}; verification=${r.verification}`).join('; ')}` : null,
    s.latestRadar.length ? `Latest radar scans: ${s.latestRadar.join("; ")}` : null,
    s.recent.length ? `Notes touched in the last 10 days: ${s.recent.join("; ")}` : null,
    `Omega fleet tracks ${s.fleet} apps/sites.`,
    s.briefExcerpt ? `\nLatest Morning Brief (${s.latestBrief}):\n${s.briefExcerpt}` : null,
  ]
    .filter((l) => l !== null)
    .join("\n");

  cache = { text, at: Date.now() };
  return text;
}

function invalidate() {
  cache = null;
}

module.exports = { buildContext, invalidate, snapshot, VAULT, OMEGA };
