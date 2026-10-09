// Unit tests for the OpenServ agent backend (openserv.mjs). No network, no chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { openservBrief, handleAction, mountOpenServ, openservClient } from "../openserv.mjs";

const H1 = "0x" + "ab".repeat(32);
const TX = "0x" + "ee".repeat(32); // a settlement tx hash: must not be read as a document
const SIGNER = "0xC628715a1ed46eb555B088e3d43dc61AE0134F33";
const cfg = { BP_REGISTRY: "0xF818e4A95BBA02c822bCa8A0CFB50a2Ae4B8eE94" };
const HASH = "$2a$10$abcdefghijklmnopqrstuuJ4b0vYk7oQx1zZ9yT3wq8s6r5p4n2m1";

function fakePlatform() {
  const calls = [];
  return {
    calls,
    complete: async (w, t, out, opt) => calls.push(["complete", w, t, out, opt]),
    error: async (w, t, e) => calls.push(["error", w, t, e]),
    chat: async (w, a, m) => calls.push(["chat", w, a, m]),
  };
}
const okLookup = async (h, signers) => ({ docHash: h, chainId: 8453, registry: cfg.BP_REGISTRY, verdict: "NOT_FOUND", attestations: [], signers });
const doTask = (extra = {}) => ({ type: "do-task", me: { id: 7 }, workspace: { id: 11 }, ...extra, task: { id: 22, description: "Look up the document hashes", ...extra.task } });

test("openservBrief reads trigger input but skips payment fields", () => {
  const a = doTask({
    explicitInput: { docHash: H1, signers: SIGNER },
    triggerEvents: [{ payload: { docHash: H1 }, payment: { txHash: TX }, transactionHash: TX }],
  });
  const text = openservBrief(a);
  assert.ok(text.includes(H1));
  assert.ok(text.includes(SIGNER));
  assert.ok(!text.includes(TX));
});

test("openservBrief reads the x402 trigger payload as the platform sends it", () => {
  // Shape captured from a live do-task action on 2026-10-09 (descriptions shortened).
  const ev = { name: "BuildProof", description: "SHA-256 of the file (0x + 64 hex)", trigger_name: "on_request", integrationName: "x402-trigger", payload: [{ event: { input: JSON.stringify({ docHash: H1, signers: "" }) }, summary: "Manual trigger" }] };
  const p = openservBrief(doTask({ task: { input: "", triggerEvent: ev }, triggerEvents: [ev] }));
  assert.ok(p.includes(H1));
});

test("openservBrief parses JSON-string task input", () => {
  const text = openservBrief(doTask({ task: { input: JSON.stringify({ docHash: H1 }) } }));
  assert.ok(text.includes(H1));
});

test("handleAction completes the task with a report", async () => {
  const platform = fakePlatform();
  const r = await handleAction(doTask({ explicitInput: { docHash: H1 }, task: { outputOptions: { opt1: { type: "text" } } } }), { platform, lookup: okLookup, cfg });
  assert.equal(r, "completed");
  const [kind, w, t, out, opt] = platform.calls[0];
  assert.deepEqual([kind, w, t, opt], ["complete", 11, 22, "opt1"]);
  assert.match(out, /NOT_FOUND/);
  assert.ok(out.includes(H1));
});

test("handleAction without a hash completes with usage, no lookup", async () => {
  const platform = fakePlatform();
  let looked = 0;
  const r = await handleAction(doTask({ explicitInput: { docHash: "hello" } }), { platform, lookup: async () => looked++, cfg });
  assert.equal(r, "no-hash");
  assert.equal(looked, 0);
  assert.match(platform.calls[0][3], /No document hash/);
});

test("handleAction marks the task errored when every lookup fails", async () => {
  const platform = fakePlatform();
  const r = await handleAction(doTask({ explicitInput: { docHash: H1 } }), {
    platform,
    lookup: async () => {
      throw new Error("rpc down");
    },
    cfg,
  });
  assert.equal(r, "rpc-failed");
  assert.equal(platform.calls[0][0], "error");
});

test("handleAction answers chat with usage and ignores unknown actions", async () => {
  const platform = fakePlatform();
  assert.equal(await handleAction({ type: "respond-chat-message", me: { id: 7 }, workspace: { id: 11 }, messages: [] }, { platform, lookup: okLookup, cfg }), "chat");
  assert.deepEqual(platform.calls[0].slice(0, 3), ["chat", 11, 7]);
  assert.equal(await handleAction({ type: "other" }, { platform, lookup: okLookup, cfg }), "ignored");
});

test("POST /openserv checks the auth hash and runs the task", async () => {
  const platform = fakePlatform();
  const app = mountOpenServ(new Hono(), () => ({ cfg, authHash: HASH, platform, lookup: okLookup }));
  const body = JSON.stringify(doTask({ explicitInput: { docHash: H1 } }));
  const post = (headers) => app.request("/openserv", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ "x-openserv-auth-token": HASH.slice(0, -1) + "x" })).status, 401);
  const ok = await post({ "x-openserv-auth-token": HASH });
  assert.equal(ok.status, 200);
  assert.equal(platform.calls[0][0], "complete");
  const slash = await app.request("/openserv/", { method: "POST", headers: { "content-type": "application/json", "x-openserv-auth-token": HASH }, body });
  assert.equal(slash.status, 200); // the platform posts to "<endpointUrl>/"
  assert.equal(platform.calls.length, 2);
  assert.equal((await app.request("/openserv/health")).status, 200);
});

test("POST /openserv is off without secrets", async () => {
  const app = mountOpenServ(new Hono(), () => null);
  const res = await app.request("/openserv", { method: "POST", body: "{}" });
  assert.equal(res.status, 503);
});

test("openservClient sends the agent key to the platform API", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([url, init.method, init.headers["x-openserv-key"], init.body]);
    return new Response("{}", { status: 200 });
  };
  await openservClient("key-1", "https://api.example", fetchImpl).complete(11, 22, "done");
  assert.deepEqual(seen[0], ["https://api.example/workspaces/11/tasks/22/complete", "PUT", "key-1", JSON.stringify({ outputOptionId: "default", output: { type: "text", value: "done" } })]);
});
