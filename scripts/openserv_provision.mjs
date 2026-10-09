// Register BuildProof on OpenServ (https://www.openserv.ai) as a paid x402 service.
//
// Run from a private directory (it reads/writes .env and .openserv.json in the cwd):
//   cd <secrets dir> && node <repo>/scripts/openserv_provision.mjs
// First run creates a wallet (WALLET_PRIVATE_KEY in .env) and signs up with it (SIWE, no
// e-mail, no KYC, no gas). Re-runs update the same agent and workflow.
//
// The agent is an external endpoint: the BuildProof Worker at <PUBLIC_URL>/openserv
// (api/openserv.mjs). Callers pay the x402 trigger on OpenServ; payout goes to PAY_TO.
// The script prints the two Worker secrets to set:
//   wrangler secret put OPENSERV_API_KEY      (agent API key)
//   wrangler secret put OPENSERV_AUTH_HASH    (auth token hash the platform sends back)
// and writes them to ./openserv_worker_secrets.json (never commit it).
import fs from "node:fs";
import { provision, triggers, PlatformClient } from "@openserv-labs/client";

const PUBLIC_URL = process.env.PUBLIC_URL || "https://buildproof-x402.zbignevich.workers.dev";
const PAY_TO = process.env.PAY_TO || "0xC628715a1ed46eb555B088e3d43dc61AE0134F33";
const PRICE = process.env.PRICE || "0.01";

if (fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}

const NAME = "BuildProof Document Verifier";
const DESCRIPTION =
  "Checks whether a document or an AI-generated output was attested on Base: give the SHA-256 of the file (0x + 64 hex) and, optionally, the wallets that should have signed. Returns a verdict (ATTESTED / SUPERSEDED / PENDING / REJECTED / NOT_FOUND / NO_MATCHING_SIGNERS), who signed and when, and whether a later amendment superseded it. Read-only lookup in the open-source BuildProofRegistry contract; nothing is written on-chain. Use it before an agent pays an invoice, accepts a contract version or relies on a model output.";

const result = await provision({
  agent: { name: NAME, description: DESCRIPTION, endpointUrl: `${PUBLIC_URL}/openserv` },
  workflow: {
    name: "BuildProof attestation check",
    goal:
      "Take the SHA-256 hash of a document (contract, amendment, acceptance act, invoice, NDA, or a manifest of an AI-generated output) and optional expected signer addresses, look the hash up in BuildProofRegistry on Base mainnet, and return a Markdown report with the attestation verdict, signers, timestamps and supersession chain.",
    trigger: triggers.x402({
      name: "BuildProof: verify a document attestation on Base",
      description: DESCRIPTION,
      price: PRICE,
      walletAddress: PAY_TO,
      timeout: 600,
      input: {
        docHash: {
          type: "string",
          title: "Document SHA-256",
          description: "SHA-256 of the file as 0x + 64 hex characters (sha256sum file.pdf). Several hashes may be separated by spaces.",
        },
        signers: {
          type: "string",
          title: "Expected signers (optional)",
          description: "Comma-separated wallet addresses (0x + 40 hex) that must have signed. Leave empty to accept any record.",
          default: "",
        },
      },
    }),
    task: {
      description: "Look up the document hashes from the trigger input in BuildProofRegistry and report the attestation status.",
    },
  },
});

// A fresh auth token whose hash this script keeps: the platform sends the hash back on
// every call and the Worker compares it byte for byte (no bcrypt in the Worker).
const state = JSON.parse(fs.readFileSync(".openserv.json", "utf8"));
const client = new PlatformClient({ apiKey: state.userApiKey });
const { authToken, authTokenHash } = await client.agents.generateAuthToken();
await client.agents.saveAuthToken({ id: result.agentId, authTokenHash });

fs.writeFileSync(
  "openserv_worker_secrets.json",
  JSON.stringify({ OPENSERV_API_KEY: result.apiKey, OPENSERV_AUTH_HASH: authTokenHash, authToken, agentId: result.agentId }, null, 2),
);
console.log(JSON.stringify({ agentId: result.agentId, workflowId: result.workflowId, triggerId: result.triggerId, paywallUrl: result.paywallUrl, apiEndpoint: result.apiEndpoint }, null, 2));
