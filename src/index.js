#!/usr/bin/env node
// Entry point. Runs one check across every configured provider (default), or loops
// forever with a status server (--loop).
import { createServer } from "node:http";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config.js";
import { localDate } from "./lib.js";
import {
  decideProvider, decideGlobal, defaultState, providerState, heartbeatDue, notify,
} from "./monitor.js";

const ts = () => new Date().toISOString();

// Last tick per provider, surfaced by the status server. Persisted state records only
// transitions, so "is it ticking right now" has to live in memory.
const lastTick = {};

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
 * Routes provider requests through a SOCKS5 proxy. Notifications stay direct, so the
 * alerting path never depends on the proxy. District needs this on datacenter hosts whose
 * IP the WAF blocks. It does nothing for BookMyShow, which blocks on TLS fingerprint
 * rather than IP; impit handles that instead.
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

/** Check one provider and return its alerts plus the next sub-state. */
async function tickProvider(cfg, p, state, now) {
  const pstate = providerState(state, p.key);

  // Best-effort daily probe, only from providers that support it and only on the
  // heartbeat tick. Its failure never counts toward the failure streak.
  let probeMax = null;
  if (p.module.probeShowDates && heartbeatDue(state, now, cfg) && !pstate.brokenAlerted) {
    try {
      probeMax = await p.module.probeShowDates(cfg, p, localDate(now, cfg.tzOffsetMinutes));
    } catch (err) {
      console.error(ts(), `[${p.key}] showDates probe failed (best-effort):`, err.message);
    }
  }

  let input;
  try {
    const res = await p.module.check(cfg, p, cfg.targetDate);
    input = res.kind === "open"
      ? { kind: "open", extract: p.module.extract(res.data, cfg, p), now, probeMax }
      : { kind: "closed", now, probeMax };
  } catch (err) {
    input = { kind: "error", reason: String(err.message ?? err), now, probeMax };
  }

  const { baseState, alerts } = decideProvider(pstate, input, cfg, p);
  lastTick[p.key] = { at: ts(), kind: input.kind, reason: input.reason ?? null };
  const matched = input.extract?.matched?.length ?? 0;
  console.log(ts(), `[${p.key}] ${input.kind}${input.reason ? ` (${input.reason})` : ""}`,
    `| matched: ${matched} | failures: ${baseState.failures}`);
  return { pstate: baseState, alerts, input };
}

export async function tick(cfg) {
  const now = new Date();
  const state = readState(cfg);
  if (state.retired) return "retired";

  const merged = structuredClone(state);
  merged.providers ??= {};
  const summaries = [];
  const expired = now.getTime() >= Date.parse(cfg.expiryUtc);

  const send = async (alert, apply) => {
    try {
      await notify(cfg, alert);
      apply();
      console.log(ts(), "alert sent:", alert.title);
    } catch (err) {
      // Patch not applied, so the push is retried on the next tick.
      console.error(ts(), `notify failed for "${alert.title}" (will retry):`, err.message);
    }
  };

  if (!expired) {
    for (const p of cfg.providers) {
      const { pstate, alerts, input } = await tickProvider(cfg, p, state, now);
      merged.providers[p.key] = pstate;
      for (const alert of alerts) {
        await send(alert, () => {
          merged.providers[p.key] = { ...merged.providers[p.key], ...alert.statePatch };
        });
      }
      summaries.push({
        label: p.label,
        kind: input.kind === "error" ? "checks failing" : merged.providers[p.key].lastGood?.kind,
        showDatesMax: merged.providers[p.key].lastGood?.showDatesMax,
      });
    }
  }

  const global = decideGlobal(state, cfg, now, summaries);
  Object.assign(merged, global.baseState, { providers: merged.providers });
  for (const alert of global.alerts) {
    await send(alert, () => Object.assign(merged, alert.statePatch));
  }

  if (JSON.stringify(merged) !== JSON.stringify(state)) {
    try {
      writeState(cfg, merged);
    } catch (err) {
      // Degrades to duplicate pushes, never missed ones — the right direction here.
      console.error(ts(), "state write failed (may duplicate pushes):", err.message);
    }
  }
  return merged.retired ? "retired" : "ok";
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
        providers: cfg.providers.map((p) => p.key),
        proxied: Boolean(cfg.dispatcher),
        retired: state.retired,
        lastTick,
        state, // never includes topic, token or proxy credentials
      };
      if (url.searchParams.get("force") === "1") {
        // Side-effect-free: no state writes, no notifications.
        out.live = {};
        for (const p of cfg.providers) {
          try {
            const r = await p.module.check(cfg, p, cfg.targetDate);
            out.live[p.key] = r.kind === "open"
              ? { kind: "open", ...p.module.extract(r.data, cfg, p) }
              : { kind: "closed" };
          } catch (err) {
            out.live[p.key] = { kind: "error", reason: String(err.message ?? err) };
          }
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
  console.log(ts(), `watching ${cfg.targetDate} on ${cfg.providers.map((p) => p.label).join(" + ")}`,
    `every ${cfg.intervalMs / 1000}s (expires ${cfg.expiryUtc})`);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
  for (;;) {
    const r = await tick(cfg).catch((err) => { console.error(ts(), "tick crashed:", err); return "crash"; });
    if (r === "retired") break;
    await new Promise((r2) => setTimeout(r2, cfg.intervalMs));
  }
} else {
  await tick(cfg);
}
