#!/usr/bin/env node
// Entry point. Runs one check (default) or loops forever with a status server (--loop).
import { createServer } from "node:http";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config.js";
import {
  decide, defaultState, extractSessions, checkDistrict, notify, heartbeatDue, localDate,
} from "./monitor.js";

const ts = () => new Date().toISOString();

// Last tick's outcome, surfaced by the status server. Persisted state records only
// transitions, so "is it ticking right now" has to live in memory.
const lastTick = { at: null, kind: null, reason: null };

function readState(cfg) {
  try {
    return { ...defaultState(), ...JSON.parse(readFileSync(cfg.statePath, "utf8")) };
  } catch {
    return defaultState(); // missing or corrupt file: start clean
  }
}

function writeState(cfg, state) {
  mkdirSync(dirname(cfg.statePath), { recursive: true });
  const tmp = cfg.statePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSync(tmp, cfg.statePath); // atomic: a killed process never leaves a torn file
}

/**
 * Routes District requests through a SOCKS5 proxy. Notifications stay direct, so the
 * alerting path never depends on the proxy. Needed on datacenter hosts whose IPs the
 * site's WAF blocks.
 */
async function attachProxy(cfg) {
  if (!cfg.proxyUrl) return;
  const u = new URL(cfg.proxyUrl);
  const { socksDispatcher } = await import("fetch-socks");
  // Node's built-in fetch bundles its own undici and rejects a dispatcher built by the
  // npm undici ("invalid onRequestStart method"), so use undici's fetch for both halves.
  const { fetch: undiciFetch } = await import("undici");
  globalThis.fetch = undiciFetch;
  cfg.dispatcher = socksDispatcher({
    type: 5,
    host: u.hostname,
    port: Number(u.port),
    ...(u.username ? { userId: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : {}),
  });
  console.log(ts(), `checks routed via SOCKS5 ${u.hostname}:${u.port}`);
}

export async function tick(cfg) {
  const now = new Date();
  const state = readState(cfg);
  if (state.retired) return "retired";

  let input;
  if (now.getTime() >= Date.parse(cfg.expiryUtc)) {
    input = { kind: "closed", now }; // decide() retires before it looks at kind
  } else {
    // Best-effort daily probe: showDates only exists in a 200 body, and the target date
    // returns an empty 204 while closed. Its failure never counts toward the streak.
    let probeMax = null;
    if (heartbeatDue(state, now, cfg) && !state.brokenAlerted) {
      try {
        const probe = await checkDistrict(cfg, localDate(now, cfg.tzOffsetMinutes));
        if (probe.kind === "open") {
          const dates = probe.data?.meta?.showDates ?? [];
          if (dates.length) probeMax = dates.slice().sort().at(-1);
        }
      } catch (err) {
        console.error(ts(), "showDates probe failed (best-effort):", err.message);
      }
    }
    try {
      const res = await checkDistrict(cfg, cfg.targetDate);
      input = res.kind === "open"
        ? { kind: "open", extract: extractSessions(res.data, cfg), now, probeMax }
        : { kind: "closed", now, probeMax };
    } catch (err) {
      input = { kind: "error", reason: String(err.message ?? err), now, probeMax };
    }
  }

  const { baseState, alerts } = decide(state, input, cfg);
  let merged = baseState;
  for (const alert of alerts) {
    try {
      await notify(cfg, alert);
      merged = { ...merged, ...alert.statePatch };
      console.log(ts(), "alert sent:", alert.title);
    } catch (err) {
      console.error(ts(), `notify failed for "${alert.title}" (will retry next tick):`, err.message);
    }
  }

  if (JSON.stringify(merged) !== JSON.stringify(state)) {
    try {
      writeState(cfg, merged);
    } catch (err) {
      // Degrades to duplicate pushes, never missed ones — the right direction here.
      console.error(ts(), "state write failed (may duplicate pushes):", err.message);
    }
  }

  lastTick.at = ts();
  lastTick.kind = input.kind;
  lastTick.reason = input.reason ?? null;
  console.log(ts(), "tick:", input.kind, input.kind === "error" ? `(${input.reason})` : "", "failures:", merged.failures);
  return input.kind;
}

function startStatusServer(cfg) {
  createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(obj, null, 1));
    };
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/healthz") return send(200, { ok: true });
      const state = readState(cfg);
      const out = {
        now: ts(),
        targetDate: cfg.targetDate,
        proxied: Boolean(cfg.dispatcher),
        retired: state.retired,
        lastTick,
        state, // never includes topic, token or proxy credentials
      };
      if (url.searchParams.get("force") === "1") {
        // Side-effect-free: no state writes, no notifications.
        try {
          const r = await checkDistrict(cfg, cfg.targetDate);
          out.live = r.kind === "open"
            ? { kind: "open", ...extractSessions(r.data, cfg) }
            : { kind: "closed" };
        } catch (err) {
          out.live = { kind: "error", reason: String(err.message ?? err) };
        }
      }
      send(200, out);
    } catch (err) {
      send(500, { error: String(err.message ?? err) });
    }
  }).listen(cfg.port, "0.0.0.0", () => console.log(ts(), `status server on :${cfg.port}`));
}

const cfg = loadConfig();
await attachProxy(cfg);

if (process.argv.includes("--loop")) {
  startStatusServer(cfg);
  console.log(ts(), `watching ${cfg.targetDate} every ${cfg.intervalMs / 1000}s (expires ${cfg.expiryUtc})`);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
  for (;;) {
    const kind = await tick(cfg).catch((err) => { console.error(ts(), "tick crashed:", err); return "crash"; });
    if (kind === "retired") break;
    await new Promise((r) => setTimeout(r, cfg.intervalMs));
  }
} else {
  await tick(cfg);
}
