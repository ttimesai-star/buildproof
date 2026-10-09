// OpenServ agent backend for BuildProof (https://www.openserv.ai, x402 services marketplace).
//
// OpenServ is the paywall: a caller pays the workflow's x402 trigger there (USDC on Base,
// payout to PAY_TO), and the platform hands the task to this agent's endpoint:
//   POST /openserv          action { type: "do-task" | "respond-chat-message", ... }
//   GET  /openserv/health   platform health check
// The agent acknowledges at once, looks the hashes up in BuildProofRegistry (read-only)
// and completes the task through the platform API with the same Markdown report the
// NEAR market gets. No LLM call, no platform credits.
//
// Secrets (wrangler secret, never in the repo):
//   OPENSERV_API_KEY    the agent's API key (x-openserv-key) from the platform
//   OPENSERV_AUTH_HASH  the bcrypt hash saved with saveAuthToken; the platform sends it back
//                       in x-openserv-auth-token on every call, compared here byte for byte
import { lookupDocument } from "./lookup.mjs";
import { parseBrief, renderReport } from "./near.mjs";

export const OPENSERV_API = "https://api.openserv.ai";

// Keys whose values are payment plumbing, not the caller's brief (a settlement tx hash is
// 64 hex characters and would otherwise be read as a document hash).
const SKIP_KEY = /payment|paid|tx|transaction|signature|nonce|payer|wallet|authori[sz]ation|settle|receipt|token|price|amount|asset|network|^id$|Id$|_id$|createdAt|updatedAt/i;

/** Collect caller-supplied strings from a JSON value, skipping payment-related keys. */
function strings(value, out = [], depth = 0) {
  if (value == null || depth > 6) return out;
  if (typeof value === "string") {
    const s = value.trim();
    if (s.startsWith("{") || s.startsWith("[")) {
      try {
        return strings(JSON.parse(s), out, depth + 1);
      } catch {}
    }
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) strings(v, out, depth + 1);
  } else if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) if (!SKIP_KEY.test(k)) strings(v, out, depth + 1);
  }
  return out;
}

/** Text the caller gave us in a do-task action: trigger input, explicit input, task input. */
export function openservBrief(action) {
  const t = action?.task ?? {};
  const parts = [];
  strings(action?.explicitInput, parts);
  strings(t.input, parts);
  strings(t.triggerEvent, parts);
  strings(action?.triggerEvents, parts);
  return parts.join("\n");
}

const USAGE =
  "Send the SHA-256 of the document as docHash (0x + 64 hex characters; several may be separated by spaces), optionally with the expected signer wallet addresses (0x + 40 hex) in signers. Hash a file yourself: `sha256sum file.pdf`, prefix 0x.";

/** Minimal client for the agent surface of the OpenServ platform API. */
export function openservClient(apiKey, base = OPENSERV_API, fetchImpl = fetch) {
  const call = async (method, path, body) => {
    const res = await fetchImpl(base + path, {
      method,
      headers: { "x-openserv-key": apiKey, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = new Error(`${method} ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`.trim());
      err.status = res.status;
      throw err;
    }
    return res.text();
  };
  return {
    // Platform schema (checked 2026-10-09): { outputOptionId, output: { type: "text", value } }.
    complete: (workspaceId, taskId, text, outputOptionId = "default") =>
      call("PUT", `/workspaces/${workspaceId}/tasks/${taskId}/complete`, { outputOptionId, output: { type: "text", value: text } }),
    error: (workspaceId, taskId, error) => call("POST", `/workspaces/${workspaceId}/tasks/${taskId}/error`, { error }),
    chat: (workspaceId, agentId, message) => call("POST", `/workspaces/${workspaceId}/agent-chat/${agentId}/message`, { message }),
  };
}

/**
 * Handle one platform action to the end.
 * @returns {Promise<string>} what was done ("completed" | "no-hash" | "rpc-failed" | "chat" | "ignored")
 */
export async function handleAction(action, { platform, lookup, cfg }) {
  const workspaceId = action?.workspace?.id;
  if (action?.type === "respond-chat-message") {
    if (workspaceId == null || action?.me?.id == null) return "ignored";
    await platform.chat(workspaceId, action.me.id, `BuildProof checks document attestations on Base. ${USAGE}`);
    return "chat";
  }
  if (action?.type !== "do-task" || workspaceId == null || action?.task?.id == null) return "ignored";
  const taskId = action.task.id;
  const optionId = Object.keys(action.task.outputOptions ?? {})[0] ?? "default";
  const parsed = parseBrief(openservBrief(action));
  if (parsed.hashes.length === 0) {
    await platform.complete(workspaceId, taskId, `# BuildProof attestation lookup\n\nNo document hash found in the request. ${USAGE}`, optionId);
    return "no-hash";
  }
  const results = [];
  for (const h of parsed.hashes) {
    try {
      results.push(await lookup(h, parsed.signers));
    } catch (e) {
      results.push({ docHash: h, error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 200) });
    }
  }
  if (results.every((r) => r.error)) {
    await platform.error(workspaceId, taskId, "The Base RPC did not answer; try again in a few minutes.");
    return "rpc-failed";
  }
  await platform.complete(workspaceId, taskId, renderReport(results, cfg, parsed), optionId);
  return "completed";
}

/** Build the dependencies from the Worker env; null when OpenServ is not configured. */
export function openservDeps(env, cfg, provider, fetchImpl) {
  if (!env?.OPENSERV_API_KEY || !env?.OPENSERV_AUTH_HASH) return null;
  return {
    cfg,
    authHash: env.OPENSERV_AUTH_HASH,
    platform: openservClient(env.OPENSERV_API_KEY, env.OPENSERV_API_URL || OPENSERV_API, fetchImpl),
    lookup: (h, signers) => lookupDocument(provider, cfg.BP_REGISTRY, h, { expectedSigners: signers }),
  };
}

function sameString(a, b) {
  a = String(a ?? "");
  b = String(b ?? "");
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Mount the OpenServ agent endpoint on a Hono app. getDeps(c) returns openservDeps(...) or null. */
export function mountOpenServ(app, getDeps) {
  app.get("/openserv/health", (c) => c.json({ status: "ok" }));
  // The platform posts to "<endpointUrl>/" (trailing slash); accept both spellings.
  const handler = async (c) => {
    const deps = getDeps(c);
    if (!deps) return c.json({ error: "OpenServ backend is not configured" }, 503);
    if (!sameString(c.req.header("x-openserv-auth-token"), deps.authHash)) return c.json({ error: "Unauthorized" }, 401);
    let action;
    try {
      action = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    if (action?.type !== "do-task" && action?.type !== "respond-chat-message") return c.json({ error: "Invalid action type" }, 400);
    console.log("openserv action", action.type, JSON.stringify({ task: action.task, explicitInput: action.explicitInput, triggerEvents: action.triggerEvents }).slice(0, 3000));
    const job = handleAction(action, deps).then(
      (r) => console.log("openserv result", r),
      (e) => console.log("openserv error", e?.message ?? e),
    );
    try {
      c.executionCtx.waitUntil(job);
    } catch {
      await job; // Node: no execution context, finish before answering
    }
    return c.json({ ok: true });
  };
  app.post("/openserv", handler);
  app.post("/openserv/", handler);
  app.post("/openserv/tools/:name", (c) => c.json({ error: `BuildProof has no runnable tool "${c.req.param("name")}"` }, 400));
  return app;
}
