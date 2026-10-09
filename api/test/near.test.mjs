// Unit tests for the NEAR AI Agent Market backend (near.mjs). No network, no chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { parseBrief, briefText, verifyWebhook, processRow, pollOnce, renderReport, mountNear } from "../near.mjs";

const H1 = "0x" + "ab".repeat(32);
const H2 = "cd".repeat(32); // bare hex, no 0x
const SIGNER = "0xC628715a1ed46eb555B088e3d43dc61AE0134F33";
const cfg = { BP_REGISTRY: "0xF818e4A95BBA02c822bCa8A0CFB50a2Ae4B8eE94" };

function fakeMarket(rows = []) {
  const calls = [];
  return {
    calls,
    assignments: async () => ({ assignments: rows }),
    start: async (id) => calls.push(["start", id]),
    submit: async (id, md) => calls.push(["submit", id, md]),
    decline: async (id, reason, detail) => calls.push(["decline", id, reason, detail]),
  };
}
const row = (description, status = "in_progress") => ({
  assignment: { assignmentId: "as-1", status },
  job: { title: "Check document", description },
  latestMessage: null,
});
const okLookup = async (h, signers) => ({ docHash: h, chainId: 8453, registry: cfg.BP_REGISTRY, verdict: "NOT_FOUND", attestations: [], signers });

test("parseBrief finds 0x and bare hashes, signer addresses, no false address inside a hash", () => {
  const p = parseBrief(`verify ${H1} and ${H2.toUpperCase()} signed by ${SIGNER}; again ${H1}`);
  assert.deepEqual(p.hashes, [H1, "0x" + H2]);
  assert.deepEqual(p.signers, [SIGNER.toLowerCase()]);
  assert.equal(parseBrief(`only ${H1}`).signers, null);
  assert.deepEqual(parseBrief("0x" + "1".repeat(65)).hashes, []); // 65 hex is not a SHA-256
  assert.deepEqual(parseBrief("hello").hashes, []);
});

test("parseBrief caps the number of hashes", () => {
  const many = Array.from({ length: 12 }, (_, i) => "0x" + i.toString(16).padStart(64, "0")).join(" ");
  const p = parseBrief(many);
  assert.equal(p.hashes.length, 10);
  assert.equal(p.truncated, true);
});

test("briefText ignores the worker's own messages", () => {
  const r = { job: { title: "t", description: "d" }, latestMessage: { senderSide: "worker", body: H1 } };
  assert.equal(parseBrief(briefText(r)).hashes.length, 0);
  r.latestMessage.senderSide = "buyer";
  assert.equal(parseBrief(briefText(r)).hashes.length, 1);
});

test("processRow submits a report for a hash", async () => {
  const market = fakeMarket();
  const out = await processRow(row(`please check ${H1} with ${SIGNER}`), { market, lookup: okLookup, cfg });
  assert.equal(out, "submitted");
  const sub = market.calls.find((c) => c[0] === "submit");
  assert.ok(sub[2].includes(H1));
  assert.ok(sub[2].includes("**NOT_FOUND**"));
  assert.ok(sub[2].includes(SIGNER.toLowerCase()));
});

test("processRow declines a brief without a hash (caller not charged)", async () => {
  const market = fakeMarket();
  assert.equal(await processRow(row("is my contract signed?"), { market, lookup: okLookup, cfg }), "declined:rejected");
  assert.equal(market.calls[0][0], "decline");
  assert.equal(market.calls[0][2], "rejected");
});

test("processRow declines as failed when every lookup fails", async () => {
  const market = fakeMarket();
  const bad = async () => {
    throw new Error("rpc down");
  };
  assert.equal(await processRow(row(H1), { market, lookup: bad, cfg }), "declined:failed");
});

test("processRow skips rows that are not in progress, and a lost submit race", async () => {
  const market = fakeMarket();
  assert.equal(await processRow(row(H1, "submitted"), { market, lookup: okLookup, cfg }), "skipped");
  market.submit = async () => {
    const e = new Error("x");
    e.status = 400;
    e.body = { error: "invalid_state_transition" };
    throw e;
  };
  assert.equal(await processRow(row(H1), { market, lookup: okLookup, cfg }), "skipped");
});

test("pollOnce works every row and survives one failing", async () => {
  const market = fakeMarket([row(H1), row("nothing here")]);
  const out = await pollOnce({ market, lookup: okLookup, cfg });
  assert.deepEqual(out, ["submitted", "declined:rejected"]);
});

test("renderReport escapes table cells", () => {
  const md = renderReport([{ docHash: H1, error: "a|b\nc" }], cfg, { signers: null, truncated: false });
  assert.ok(md.includes("a\\|b c"));
});

const SECRET = "s".repeat(40);
const sign = (ts, body, secret = SECRET) => "sha256=" + createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");

test("verifyWebhook accepts the marketplace signature and rejects tampering and stale timestamps", async () => {
  const now = 1_800_000_000;
  const body = '{"event":"webhook.ping"}';
  assert.equal(await verifyWebhook(SECRET, String(now), body, sign(now, body), now), true);
  assert.equal(await verifyWebhook(SECRET, String(now), body + " ", sign(now, body), now), false);
  assert.equal(await verifyWebhook(SECRET, String(now), body, sign(now, body, "x".repeat(40)), now), false);
  assert.equal(await verifyWebhook(SECRET, String(now - 301), body, sign(now - 301, body), now), false);
  assert.equal(await verifyWebhook(undefined, String(now), body, sign(now, body), now), false);
});

test("webhook route: 401 on bad signature, works the assignment on hire.created", async () => {
  const market = fakeMarket([row(H1)]);
  const app = mountNear(new Hono(), () => ({ market, lookup: okLookup, cfg }), () => SECRET);
  const body = JSON.stringify({ event: "hire.created", assignment_id: "as-1" });
  const ts = String(Math.floor(Date.now() / 1000));
  const bad = await app.request("/near/webhook", { method: "POST", body, headers: { "X-Market-Timestamp": ts, "X-Market-Signature": "sha256=00" } });
  assert.equal(bad.status, 401);
  const res = await app.request("/near/webhook", {
    method: "POST",
    body,
    headers: { "X-Market-Event": "hire.created", "X-Market-Timestamp": ts, "X-Market-Signature": sign(ts, body) },
  });
  assert.equal(res.status, 200);
  assert.ok(market.calls.some((c) => c[0] === "submit"));
});

test("webhook route: ping is acknowledged without work", async () => {
  const market = fakeMarket([row(H1)]);
  const app = mountNear(new Hono(), () => ({ market, lookup: okLookup, cfg }), () => SECRET);
  const body = JSON.stringify({ event: "webhook.ping", test: true });
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await app.request("/near/webhook", { method: "POST", body, headers: { "X-Market-Timestamp": ts, "X-Market-Signature": sign(ts, body) } });
  assert.equal(res.status, 200);
  assert.equal(market.calls.length, 0);
});
