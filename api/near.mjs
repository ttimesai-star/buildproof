// NEAR AI Agent Market worker for BuildProof (https://market.near.ai, handle "buildproof").
//
// The marketplace is the A2A + x402 server: a caller pays there (USDC on NEAR) and the
// call becomes an assignment for this agent. This module is the backend half:
//   - POST /near/webhook   signed marketplace events; acknowledges at once, then works
//   - scheduled()          cron poll of GET /v1/agents/me/assignments (missed webhooks,
//                          and the liveness stamp the marketplace needs to route calls)
// Each assignment: read SHA-256 hashes (and optional expected signer addresses) from the
// brief, look them up in BuildProofRegistry, submit a Markdown report. A brief with no
// hash is declined with reason "rejected", so the caller is not charged.
//
// Secrets (wrangler secret, never in the repo): NEAR_MARKET_TOKEN (aat_...), NEAR_WEBHOOK_SECRET.
import { lookupDocument } from "./lookup.mjs";

export const MARKET_URL = "https://market.near.ai";
const MAX_HASHES = 10;
const MAX_SKEW_SECONDS = 300;

const HASH_G = /(?<![0-9a-fA-Fx])(?:0x)?([0-9a-fA-F]{64})(?![0-9a-fA-F])/g;
const ADDR_G = /(?<![0-9a-fA-F])0x([0-9a-fA-F]{40})(?![0-9a-fA-F])/g;

/** Pull document hashes and expected signer addresses out of free text. */
export function parseBrief(text) {
  const s = String(text ?? "");
  const hashes = [...new Set([...s.matchAll(HASH_G)].map((m) => "0x" + m[1].toLowerCase()))];
  const signers = [...new Set([...s.matchAll(ADDR_G)].map((m) => "0x" + m[1].toLowerCase()))];
  return { hashes: hashes.slice(0, MAX_HASHES), signers: signers.length ? signers : null, truncated: hashes.length > MAX_HASHES };
}

/** Text the buyer gave us: job title + description + their latest message. */
export function briefText(row) {
  const parts = [row?.job?.title, row?.job?.description];
  if (row?.latestMessage && row.latestMessage.senderSide === "buyer") parts.push(row.latestMessage.body);
  return parts.filter(Boolean).join("\n");
}

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const escCell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");

/** Markdown deliverable for a list of lookup results. */
export function renderReport(results, cfg, parsed) {
  const lines = [
    "# BuildProof attestation lookup",
    "",
    `Registry \`${cfg.BP_REGISTRY}\` on chain ${results[0]?.chainId ?? "?"} (Base mainnet = 8453). Read-only lookup, nothing was written on-chain.`,
    parsed.signers ? `Expected signers: ${parsed.signers.map((a) => `\`${a}\``).join(", ")} (only records with exactly this signer set count).` : "No expected signers given: every record counts. Anyone can register any hash, so check who signed.",
    "",
    "| Document hash | Verdict | Records | Signers of the newest record |",
    "|---|---|---|---|",
  ];
  for (const r of results) {
    if (r.error) {
      lines.push(`| \`${r.docHash}\` | ERROR | - | ${escCell(r.error)} |`);
      continue;
    }
    const last = r.attestations[r.attestations.length - 1];
    const who = last ? last.signers.map((s) => `${short(s.address)} ${s.state}`).join(", ") : "-";
    lines.push(`| \`${r.docHash}\` | **${r.verdict}** | ${r.attestations.length} | ${escCell(who)} |`);
  }
  if (parsed.truncated) lines.push("", `Only the first ${MAX_HASHES} hashes were checked.`);
  lines.push(
    "",
    "Verdicts: ATTESTED = every required signer signed; SUPERSEDED = attested, later replaced by an attested amendment; PENDING = registered, not all signed; REJECTED = a signer rejected it; NOT_FOUND = no record; NO_MATCHING_SIGNERS = records exist, none with your signer set.",
    "",
    "## Raw result",
    "",
    "```json",
    JSON.stringify(results, null, 2),
    "```",
    "",
    "Hash a file yourself: `sha256sum file.pdf` (prefix 0x). Verify page: https://ttimesai-star.github.io/buildproof/ · source: https://github.com/ttimesai-star/buildproof",
  );
  return lines.join("\n");
}

/** Minimal client for the worker surface of the marketplace. */
export function marketClient(token, base = MARKET_URL, fetchImpl = fetch) {
  const call = async (method, path, body) => {
    const res = await fetchImpl(base + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) {
      const err = new Error(`${method} ${path} -> ${res.status} ${json?.error ?? ""}`.trim());
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  };
  return {
    assignments: () => call("GET", "/v1/agents/me/assignments"),
    start: (id) => call("POST", `/v1/assignments/${id}/start`),
    submit: (id, deliverableMarkdown) => call("POST", `/v1/assignments/${id}/submit`, { deliverableMarkdown }),
    decline: (id, reason, detail) => call("POST", `/v1/assignments/${id}/decline`, { reason, detail }),
  };
}

/**
 * Work one assignment row to the end: submit a report, or decline.
 * @returns {Promise<string>} what was done ("submitted" | "declined:<reason>" | "skipped")
 */
export async function processRow(row, { market, lookup, cfg }) {
  const a = row.assignment;
  if (!a || a.status !== "in_progress") return "skipped";
  const id = a.assignmentId;
  const parsed = parseBrief(briefText(row));
  if (parsed.hashes.length === 0) {
    await market.decline(
      id,
      "rejected",
      "No document hash found. Send the SHA-256 of the file as 0x + 64 hex characters (one or more), optionally with the expected signer wallet addresses (0x + 40 hex). You were not charged.",
    );
    return "declined:rejected";
  }
  await market.start(id).catch(() => {});
  const results = [];
  for (const h of parsed.hashes) {
    try {
      results.push(await lookup(h, parsed.signers));
    } catch (e) {
      results.push({ docHash: h, error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 200) });
    }
  }
  if (results.every((r) => r.error)) {
    await market.decline(id, "failed", "The Base RPC did not answer; nothing was charged. Try again in a few minutes.");
    return "declined:failed";
  }
  try {
    await market.submit(id, renderReport(results, cfg, parsed));
  } catch (e) {
    // Webhook and cron may race on the same row; a second submit is refused, which is fine.
    if (e.status === 400 && e.body?.error === "invalid_state_transition") return "skipped";
    throw e;
  }
  return "submitted";
}

/** Poll the assignment list once and work every in-progress row. */
export async function pollOnce(deps) {
  const { assignments } = await deps.market.assignments();
  const done = [];
  for (const row of assignments ?? []) {
    try {
      done.push(await processRow(row, deps));
    } catch (e) {
      done.push(`error:${e.message}`);
    }
  }
  return done;
}

const enc = new TextEncoder();

/** Check X-Market-Signature: sha256=hex(HMAC-SHA256(secret, "<ts>.<raw body>")). */
export async function verifyWebhook(secret, timestamp, rawBody, signatureHeader, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!secret || !timestamp || !signatureHeader) return false;
  if (!/^\d+$/.test(timestamp) || Math.abs(nowSeconds - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${rawBody}`)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  const provided = String(signatureHeader).replace(/^sha256=/, "").toLowerCase();
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

/** Build the dependencies from the Worker env; null when the marketplace is not configured. */
export function nearDeps(env, cfg, provider, fetchImpl) {
  if (!env?.NEAR_MARKET_TOKEN) return null;
  return {
    cfg,
    market: marketClient(env.NEAR_MARKET_TOKEN, env.NEAR_MARKET_URL || MARKET_URL, fetchImpl),
    lookup: (h, signers) => lookupDocument(provider, cfg.BP_REGISTRY, h, { expectedSigners: signers }),
  };
}

const WORK_EVENTS = new Set(["hire.created", "hire.changes_requested", "hire.dispute_resolved", "message.created"]);

/** Mount POST /near/webhook on a Hono app. getDeps(c) returns nearDeps(...) or null. */
export function mountNear(app, getDeps, getSecret) {
  app.post("/near/webhook", async (c) => {
    const raw = await c.req.text();
    const ok = await verifyWebhook(getSecret(c), c.req.header("X-Market-Timestamp"), raw, c.req.header("X-Market-Signature"));
    if (!ok) return c.json({ error: "bad signature" }, 401);
    let event = c.req.header("X-Market-Event");
    try {
      event = JSON.parse(raw).event ?? event;
    } catch {}
    const deps = getDeps(c);
    if (deps && WORK_EVENTS.has(event)) {
      const job = pollOnce(deps).catch(() => {});
      try {
        c.executionCtx.waitUntil(job);
      } catch {
        await job; // Node: no execution context, finish before answering
      }
    }
    return c.json({ ok: true });
  });
  return app;
}
