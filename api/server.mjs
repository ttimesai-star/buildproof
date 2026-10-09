#!/usr/bin/env node
// Local Node server for the same app: node api/server.mjs
// Env: BP_RPC, BP_REGISTRY (or deployments/<chainId>.json), PAY_TO, PRICE, X402_NETWORK, FACILITATOR_URL, PORT.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { configFrom, createApp } from "./app.mjs";

const env = { ...process.env };
env.BP_RPC ??= "http://127.0.0.1:8545";
if (!env.BP_REGISTRY) {
  const f = new URL("../deployments/31337.json", import.meta.url);
  if (existsSync(f)) env.BP_REGISTRY = JSON.parse(readFileSync(f, "utf8")).registry;
}
const app = createApp(configFrom(env));
const port = Number(env.PORT ?? 8787);

export function nodeHandler(fetchApp) {
  return async (req, res) => {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const url = `http://${req.headers.host ?? "localhost"}${req.url}`;
    const init = { method: req.method, headers: req.headers };
    if (chunks.length && req.method !== "GET" && req.method !== "HEAD") init.body = Buffer.concat(chunks);
    const r = await fetchApp.fetch(new Request(url, init));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  };
}

createServer(nodeHandler(app)).listen(port, () => console.log(`BuildProof x402 API on http://localhost:${port}`));
