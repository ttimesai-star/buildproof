// BuildProof paid verification API (x402, USDC).
// GET /v1/attestation/:docHash  -> status of a document hash in BuildProofRegistry.
// Unpaid requests get 402 + PAYMENT-REQUIRED; a facilitator verifies and settles the
// buyer's signed USDC authorization. Funds go straight to PAY_TO: this service never
// holds a key and never sends a transaction.
import { Hono } from "hono";
import { ethers } from "ethers";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { lookupDocument, parseSigners, HASH_RE } from "./lookup.mjs";

export const DEFAULTS = {
  PAY_TO: "0xC628715a1ed46eb555B088e3d43dc61AE0134F33",
  PRICE: "$0.01",
  X402_NETWORK: "eip155:84532", // Base Sepolia; production: eip155:8453 (Base)
  FACILITATOR_URL: "https://x402.org/facilitator", // testnet only; see api/README.md for mainnet
};

/** Resolve configuration from a plain object (Worker `env` or `process.env`). */
export function configFrom(env = {}) {
  const cfg = { ...DEFAULTS };
  for (const k of ["PAY_TO", "PRICE", "X402_NETWORK", "FACILITATOR_URL", "BP_RPC", "BP_REGISTRY", "PUBLIC_URL"]) if (env[k]) cfg[k] = env[k];
  cfg.PAY_TO = ethers.getAddress(cfg.PAY_TO);
  if (!cfg.BP_RPC || !cfg.BP_REGISTRY) throw new Error("BP_RPC and BP_REGISTRY are required (chain where the registry lives)");
  cfg.BP_REGISTRY = ethers.getAddress(cfg.BP_REGISTRY);
  return cfg;
}

const ROUTE = "GET /v1/attestation/*";

export function openapi(cfg) {
  return {
    openapi: "3.1.0",
    info: {
      title: "BuildProof document attestation lookup",
      version: "0.2.0",
      description:
        "Send the SHA-256 of a construction document (contract, supplementary agreement, acceptance act). Get whether it was signed, by which wallets, when, and whether a later amendment superseded it. Paid per request in USDC over x402.",
    },
    servers: cfg.PUBLIC_URL ? [{ url: cfg.PUBLIC_URL }] : [],
    paths: {
      "/v1/attestation/{docHash}": {
        get: {
          summary: "Attestation status of a document hash",
          "x-payment-info": { protocol: "x402", price: cfg.PRICE, network: cfg.X402_NETWORK, asset: "USDC", payTo: cfg.PAY_TO },
          parameters: [
            { name: "docHash", in: "path", required: true, schema: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" }, description: "0x-prefixed SHA-256 of the exact file bytes" },
            { name: "signers", in: "query", required: false, schema: { type: "string" }, description: "Comma-separated wallet addresses you expect as signers; records with other signer sets are not counted in the verdict" },
          ],
          responses: {
            200: {
              description: "Lookup result",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      docHash: { type: "string" },
                      chainId: { type: "integer" },
                      registry: { type: "string" },
                      verdict: { type: "string", enum: ["ATTESTED", "SUPERSEDED", "PENDING", "REJECTED", "NOT_FOUND", "NO_MATCHING_SIGNERS"] },
                      attestations: { type: "array", items: { type: "object" } },
                    },
                  },
                },
              },
            },
            400: { description: "Malformed hash or signer address (not charged)" },
            402: { description: "Payment required (x402)" },
          },
        },
      },
    },
  };
}

/**
 * Build the Hono app.
 * @param {object} cfg from configFrom()
 * @param {object} [deps] { facilitator?: FacilitatorClient, provider?: ethers.Provider }
 */
export function createApp(cfg, deps = {}) {
  const facilitator = deps.facilitator ?? new HTTPFacilitatorClient({ url: cfg.FACILITATOR_URL });
  const provider = deps.provider ?? new ethers.JsonRpcProvider(cfg.BP_RPC, undefined, { staticNetwork: true });
  const resourceServer = new x402ResourceServer(facilitator).register(cfg.X402_NETWORK, new ExactEvmScheme());

  const app = new Hono();

  app.get("/", (c) =>
    c.json({
      service: "BuildProof attestation lookup",
      paid: "GET /v1/attestation/{sha256}",
      price: cfg.PRICE,
      network: cfg.X402_NETWORK,
      payTo: cfg.PAY_TO,
      registry: cfg.BP_REGISTRY,
      openapi: "/openapi.json",
      source: "https://github.com/ttimesai-star/buildproof",
    }),
  );
  app.get("/openapi.json", (c) => c.json(openapi(cfg)));
  app.get("/health", (c) => c.json({ ok: true }));

  // Validate before asking for money: a malformed request is never charged.
  app.use("/v1/attestation/*", async (c, next) => {
    const docHash = c.req.path.split("/").pop();
    if (!HASH_RE.test(docHash)) return c.json({ error: "docHash must be 0x + 64 hex chars (SHA-256 of the file)" }, 400);
    try {
      c.set("expectedSigners", parseSigners(c.req.query("signers")));
    } catch {
      return c.json({ error: "signers must be comma-separated EVM addresses" }, 400);
    }
    await next();
  });

  app.use(
    paymentMiddleware(
      {
        [ROUTE]: {
          accepts: { scheme: "exact", price: cfg.PRICE, network: cfg.X402_NETWORK, payTo: cfg.PAY_TO, maxTimeoutSeconds: 120 },
          description: "BuildProof: attestation status of a construction document by SHA-256 (signed, by whom, when, superseded by an amendment)",
          mimeType: "application/json",
          serviceName: "BuildProof",
          tags: ["legal", "documents", "attestation", "construction"],
        },
      },
      resourceServer,
      undefined,
      undefined,
      deps.syncFacilitatorOnStart ?? true,
    ),
  );

  app.get("/v1/attestation/:docHash", async (c) => {
    try {
      const out = await lookupDocument(provider, cfg.BP_REGISTRY, c.req.param("docHash"), { expectedSigners: c.get("expectedSigners") });
      return c.json(out);
    } catch (e) {
      // status >= 400: the x402 middleware does not settle, so the buyer is not charged.
      return c.json({ error: "registry lookup failed", detail: String(e?.shortMessage ?? e?.message ?? e) }, 502);
    }
  });

  return app;
}
