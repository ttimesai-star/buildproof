# BuildProof paid lookup API (x402)

An AI agent (or any HTTP client) sends the SHA-256 of a document and gets back whether it was attested in `BuildProofRegistry`: who signed, when, whether a party rejected it, and whether a later supplementary agreement superseded it. Each answer costs **$0.01 in USDC**, paid over [x402](https://docs.x402.org): no account, no API key, the payment is the authentication.

```
GET /v1/attestation/{sha256}?signers=0xClient,0xContractor
  -> 402 Payment Required   (PAYMENT-REQUIRED header: exact scheme, USDC, amount 10000, payTo)
  -> client signs an EIP-3009 USDC authorization, retries with PAYMENT-SIGNATURE
  -> 200 + JSON + PAYMENT-RESPONSE (settlement tx)
```

The service is read-only. It holds **no private key** and never sends a transaction: the buyer signs the USDC transfer, a facilitator submits it and pays the gas, and the USDC goes straight to `PAY_TO`. A malformed hash or signer list returns `400` before any price is quoted, and a failed registry read returns `502`, which the x402 middleware never settles, so the buyer is not charged for it.

Free routes: `GET /` (service info), `GET /openapi.json`, `GET /health`.

## Response

```json
{
  "docHash": "0x…",
  "chainId": 84532,
  "registry": "0x…",
  "verdict": "ATTESTED | SUPERSEDED | PENDING | REJECTED | NOT_FOUND | NO_MATCHING_SIGNERS",
  "attestations": [{
    "id": "0x…", "docType": "acceptance-act", "status": "ATTESTED",
    "superseded": false, "supersededBy": null, "supersedes": null,
    "registrar": "0x…", "registeredAt": "2026-10-09T12:00:00.000Z", "closedAt": "2026-10-09T12:00:04.000Z",
    "signedCount": 2, "signerCount": 2,
    "signers": [{ "address": "0x…", "state": "signed" }, { "address": "0x…", "state": "signed" }],
    "matchesExpectedSigners": true
  }]
}
```

Anyone can register any hash with any signer list, so pass `?signers=` with the parties you expect. Then the verdict counts only records whose signer set is exactly that list (a stranger's fake record shows up, but with `matchesExpectedSigners: false`).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PAY_TO` | `0xC628715a1ed46eb555B088e3d43dc61AE0134F33` | where USDC is paid |
| `PRICE` | `$0.01` | price per lookup |
| `X402_NETWORK` | `eip155:84532` (Base Sepolia) | payment chain, CAIP-2; production `eip155:8453` (Base) |
| `FACILITATOR_URL` | `https://x402.org/facilitator` | verifies and settles payments; testnet only, see below |
| `BP_RPC`, `BP_REGISTRY` | (required) | chain and address of the registry being queried |
| `PUBLIC_URL` | (empty) | base URL written into `openapi.json` |

The payment chain and the registry chain are independent: payment can be on Base mainnet while the registry is still on a testnet.

## Run locally

```bash
npm install
anvil &                                   # or point BP_RPC at a public chain
bash scripts/demo.sh                      # deploys the registry, writes deployments/31337.json
node api/server.mjs                       # http://localhost:8787
curl -i http://localhost:8787/v1/attestation/$(node cli/buildproof.mjs hash examples/pdf/act_01.pdf)
```

## Tests

```bash
forge build
node --test api/test/api.test.mjs         # set ANVIL_BIN if anvil is not on PATH
```

The test starts anvil, deploys the real registry, registers a contract, its amendment, a clean act, a rejected act, a pending act and a stranger's fake record. A real x402 buyer client (`@x402/fetch` + `@x402/evm`) pays every request with an EIP-3009 signature. An in-process facilitator checks that signature the way a real facilitator does and records the settlement. Checked: the 402 price list (USDC on Base Sepolia, 10000 units, our `payTo`), no charge for malformed input, each verdict, the signer filter, the amendment link, and refusal of a payment addressed to someone else.

## Deploy to Cloudflare Workers (free plan)

The Worker needs a Cloudflare account (e-mail sign-up). The free plan (100,000 requests a day) needs no card. No secrets are required, because the service holds no key.

```bash
npx wrangler login
# edit api/wrangler.toml: BP_RPC / BP_REGISTRY of the deployed registry, PUBLIC_URL
npx wrangler deploy --config api/wrangler.toml
curl -i https://buildproof-x402.<your-subdomain>.workers.dev/v1/attestation/0x…   # expect 402
```

### Deploy with the stored API token (no browser login)

Account: `Zbignevich@gmail.com's Account` (id `8f9a77b025c2f958f915b1b4da43c036`), free plan, subdomain `zbignevich.workers.dev`. A scoped user API token `buildproof-workers-deploy` (created 2026-10-09) lives in `~/.claude/secrets/cloudflare_workers.json` (`account_id`, `token`, `scope`, `created`). Permissions: this account only, **Workers Scripts: Edit** + **Account Settings: Read**; no zones/DNS, no KV, no expiry, no IP filter. Never print or commit the token.

```bash
export CLOUDFLARE_API_TOKEN=$(python -c "import json,os;print(json.load(open(os.path.expanduser('~/.claude/secrets/cloudflare_workers.json')))['token'])")
export CLOUDFLARE_ACCOUNT_ID=8f9a77b025c2f958f915b1b4da43c036
npx wrangler whoami                                   # shows the account; "Unable to retrieve email" is expected (no User Details scope)
npx wrangler deploy --config api/wrangler.toml        # -> https://buildproof-x402.zbignevich.workers.dev
```

Checked 2026-10-09 with a throwaway hello Worker: `deploy` -> HTTP 200 on workers.dev, `delete --name <worker> --force` removed it. `wrangler delete` then reports an authentication error on `/storage/kv/namespaces` (it tries to clean up KV and the token has no KV scope); the Worker is still deleted. If the service ever needs KV, recreate the token with `Workers KV Storage: Edit` added. Other Workers on this account (`telegram-bridge`, `agent-signer-tc1695`, `gentle-disk-1fe5`) are not ours to touch.

`nodejs_compat` is enabled in `wrangler.toml` (one dependency imports `url`). The bundle is about 1.4 MB before compression, well under the free-plan limit. CI checks that it bundles.

Alternative without Cloudflare: any Node 20+ host running `node api/server.mjs`.

## Live deployment (Base mainnet, 2026-10-09)

`https://buildproof-x402.zbignevich.workers.dev` reads the registry `0xF818e4A95BBA02c822bCa8A0CFB50a2Ae4B8eE94` on Base mainnet and quotes `exact`, 10000 units of USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` on `eip155:8453` to `0xC628715a1ed46eb555B088e3d43dc61AE0134F33`, facilitator PayAI (no API key). Checked: `/health` 200, `/` 200, unpaid lookup 402 with that price list, malformed hash 400. A paid call on mainnet has not been run yet (needs a buyer wallet with USDC on Base).

## Facilitators for mainnet

`x402.org/facilitator` serves testnets only (Base Sepolia, Solana devnet). For Base mainnet set `FACILITATOR_URL` to a production facilitator. Options listed in the [x402 docs](https://docs.x402.org/dev-tools/facilitators):

- **PayAI** (`https://facilitator.payai.network`): "No API keys required". Its `/supported` lists `eip155:8453` exact.
- **Circle Facilitator Service** (`https://api.circle.com/v1/facilitator/x402/...`): a keyless trial, then a Circle API key. Each call needs a `Facilitator-Seller-Proof` header, an EIP-712 signature by the key that controls `payTo`. That means the server would have to hold the payout key, so this adapter is not included on purpose.
- **Coinbase CDP**: needs a CDP API key (account).

Every facilitator screens the payer and the payee. Check its terms for your jurisdiction before going to mainnet.

## Listing in the Circle Agent Marketplace

The marketplace takes a live x402 endpoint, an OpenAPI spec (`/openapi.json`) and a payout wallet, which is sanctions-screened. Submission is a form, reviewed manually: https://developers.circle.com/agent-stack/agent-marketplace/get-listed

## Listed on the NEAR AI Agent Market (A2A + x402)

Agent `buildproof`: card at `https://buildproof.market.near.ai/.well-known/agent-card.json`, listing at https://market.near.ai/a/buildproof. The marketplace is the A2A server and takes the payment itself: a caller sends `SendMessage` to `https://buildproof.market.near.ai/a2a/v1`, gets a 402 for $0.01 (10000 units of USDC on `near:mainnet`), pays, and the call becomes an assignment for this agent. The payment settles only when we deliver.

The backend is [near.mjs](near.mjs), in the same Worker:

- `POST /near/webhook` checks the marketplace HMAC (`X-Market-Signature` over `<timestamp>.<raw body>`, 5-minute skew), answers 200 at once and works the assignments in `waitUntil`.
- A cron trigger (`* * * * *`) polls `GET /v1/agents/me/assignments`: it picks up a missed webhook and keeps the liveness stamp fresh, without which the marketplace stops routing calls.
- For each assignment it reads the SHA-256 hashes (up to 10) and optional expected signer addresses from the brief, runs the same `lookupDocument` as the x402 API and submits a Markdown table plus the raw JSON. No hash in the brief: `decline` with `rejected`, so the caller is not charged. RPC down: `decline` with `failed`.

Secrets (Cloudflare, never in the repo): `NEAR_MARKET_TOKEN` (the agent's `aat_` token) and `NEAR_WEBHOOK_SECRET`:

```bash
npx wrangler secret put NEAR_MARKET_TOKEN --config api/wrangler.toml
npx wrangler secret put NEAR_WEBHOOK_SECRET --config api/wrangler.toml
```

Without them the route answers 401 and the cron does nothing. Tests: `node --test api/test/near.test.mjs` (brief parsing, signature check, submit and decline paths, webhook route).
