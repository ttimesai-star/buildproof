# BuildProof

**A notary registry for construction paperwork.** Contracts, supplementary agreements, acceptance acts and as-built documentation get a SHA-256 fingerprint on an EVM chain, signed by every party's wallet. Before anyone signs, a cross-check compares each act against the contract and its amendments: amounts, volumes, rates, dates, bank details. Anyone can later check a file by its hash without the content ever being published.

Built for the [BLI Legal Tech Hackathon 2](https://dorahacks.io/hackathon/legal-hack-2026/detail), tracks *LegalTech & RegTech* and *AI x Blockchain*.

> Status: working MVP on a local chain (`anvil`). Testnet deployment (Base Sepolia) is pending test ETH; see [Deployment](#deployment).

## The problem

I direct a construction and real-estate development company. Every month the same paperwork crosses between the client, the general contractor, subcontractors and technical supervision: acceptance acts for completed work, invoices, supplementary agreements that change quantities or unit rates, as-built documentation. It travels as scans and PDFs by e-mail and messengers.

Two things go wrong, and both are boring and expensive:

1. **Which version was signed?** A PDF can be re-exported with one number changed. When a dispute comes up months later, the parties compare files from their mailboxes and argue about which one is the signed one.
2. **Does the act match the contract?** Checking an act means re-doing arithmetic and walking back through the contract and every amendment: is this the current unit rate, did the cumulative volume exceed what was agreed, is the bank account the one in the contract? It is done by hand, under time pressure, and errors pass.

BuildProof does not replace the legal signature required by local law. It adds a tamper-evident, shared record of *exactly which bytes* each party approved, plus a machine check before approval.

## What it does

```
 PDF ──sha256──► hash ──register──► BuildProofRegistry (EVM)
                  │                    ▲          ▲
                  │        sign (tx) ──┘          └── signBySig (EIP-712, relayed, no gas)
                  │
 contract + amendments + acts ──► cross-check ──► findings ──► sign  or  reject(reportHash)
                                                                    
 verify page: drop a file → hash in the browser → attestations, signers, status, amendments
```

- **Registry contract** ([contracts/BuildProofRegistry.sol](contracts/BuildProofRegistry.sol)). A record holds the file hash, document type, project reference, required signers and an optional link to the document it amends. It becomes `ATTESTED` only when every required signer has signed. A signer may `reject` with the hash of the reason (e.g. the cross-check report). When an amendment is attested, the original is marked `supersededBy`. Signers can sign directly or give an EIP-712 signature that anyone can relay, so a party without gas can still sign.
- **Trust model.** Anyone can register any hash, so a stranger can front-run with fake signers. That does not block the real record (ids include the registrar and the signer list), and the verifier always sees *who* signed. Supply the expected party addresses and the page tells you whether a record matches them.
- **Cross-check** ([checker/crosscheck.py](checker/crosscheck.py)). It reads the contract, supplementary agreements and acts and applies deterministic rules: line arithmetic, subtotal, VAT and total; contract reference; party names, tax IDs and IBANs; dates against the contract term; the unit rate in force for the act period (amendments apply from their effective date); cumulative volume per item against the amended contract quantity; total against the contract price. With `--llm`, a language model *extracts* the fields as well (any OpenAI-compatible endpoint), and the two extractions are compared field by field. **The model never decides.** Every finding is arithmetic on two numbers you can point at, so it cannot hallucinate a violation.
- **CLI** ([cli/buildproof.mjs](cli/buildproof.mjs)): `hash`, `deploy`, `register`, `sign`, `sign-offline`, `relay`, `reject`, `status`, `verify`.
- **Verify page** ([docs/](docs/), GitHub Pages). It hashes the file locally with WebCrypto and reads the chain through a public RPC. A party can also sign with a browser wallet (EIP-712) and send the signature to the other side.

- **Paid lookup API for agents** ([api/](api/README.md)). `GET /v1/attestation/{sha256}` returns the verdict (`ATTESTED`, `SUPERSEDED`, `PENDING`, `REJECTED`, `NOT_FOUND`), the signers and the dates. The price is $0.01 in USDC per request over [x402](https://docs.x402.org). The service is read-only and holds no key. It runs as a Cloudflare Worker or with Node.

## Demo

All documents in [examples/](examples/) are **synthetic** with fictional parties (`Alder Street Development Ltd.` as client, `Granite & Beam Construction LLC` as contractor, invalid test IBANs). The PDFs are byte-reproducible from [examples/source/documents.json](examples/source/documents.json).

| Document | Planted problem | Found by the cross-check |
|---|---|---|
| Contract GC-2026/014 | none | - |
| Supplementary Agreement No. 1 | none (qty of item 2: 340→380; rate of item 4: 27.50→29.00 from 2026-06-01) | - |
| Act No. 1 | none | clean |
| Act No. 2 | 400 × 42.00 written as 18,600.00 | `LINE_ARITHMETIC` |
| | new roofing rate used before its effective date | `RATE` |
| Act No. 3 | refers to contract GC-2026/**041** | `CONTRACT_REF` |
| | contractor IBAN differs from the contract | `PARTY_IBAN` |
| | masonry: 400 + 600 = 1,000 m² against 950 m² in the contract | `QUANTITY_OVERRUN` |
| | VAT 6,870.00 instead of 6,780.00 | `VAT` |

Run the whole story (local chain, about 30 seconds):

```bash
# prerequisites: Foundry (forge, anvil), Node 18+, Python 3.10+
pip install pypdf reportlab pytest
npm install
forge install foundry-rs/forge-std --no-git
bash scripts/demo.sh
```

The script renders the PDFs, runs the cross-check, deploys the registry to `anvil`, and then:

1. registers the contract; the client signs with a transaction, the contractor signs **offline** (EIP-712) and a relayer submits it;
2. registers Supplementary Agreement No. 1 as an amendment; once both sign, the contract shows `SUPERSEDED`;
3. Act No. 1 passes the check and both parties sign it;
4. Act No. 2 fails the check: the contractor has signed, the client **rejects** it with the SHA-256 of the cross-check report;
5. verifies the original Act No. 1 (`VALID`, signed by the expected parties) and a copy with one changed amount (`NOT FOUND`).

Then open the verify page against the same local chain:

```bash
python -m http.server 8000 --directory docs   # open http://localhost:8000, choose "Local anvil"
```

The hosted page (https://ttimesai-star.github.io/buildproof/) can also talk to your local anvil, but Chrome will ask for permission to access devices on your local network; allow it, or use the local server above.

## Tests

```bash
forge test                                 # 20 tests including fuzzing: signatures, replay, malleability, griefing, amendments
python checker/tests/test_crosscheck.py    # the cross-check finds exactly the planted problems and nothing else
node --test api/test/api.test.mjs          # x402 API: 402 price list, paid lookups on a live anvil registry, refused bad payments
```

## CLI reference

```bash
node cli/buildproof.mjs hash examples/pdf/act_01.pdf
BP_PRIVATE_KEY=... node cli/buildproof.mjs register act.pdf --type acceptance-act --project PLOT-7 --signers 0xClient,0xContractor
BP_PRIVATE_KEY=... node cli/buildproof.mjs sign-offline <id> --file act.pdf --out sig.json   # refuses if the file does not match the hash
BP_PRIVATE_KEY=... node cli/buildproof.mjs relay sig.json
BP_PRIVATE_KEY=... node cli/buildproof.mjs reject <id> --reason crosscheck.json
node cli/buildproof.mjs verify act.pdf --parties parties.json
```

Network options: `--rpc` or `BP_RPC`; registry `--registry`, `BP_REGISTRY`, or `deployments/<chainId>.json`.

Cross-check with a model (example: any OpenAI-compatible provider):

```bash
export BP_LLM_BASE_URL=https://integrate.api.nvidia.com/v1 BP_LLM_API_KEY=... BP_LLM_MODEL=nvidia/nemotron-3-super-120b-a12b
python checker/crosscheck.py examples/pdf/*.pdf --llm        # rules on regex fields + LLM extraction compared
python checker/crosscheck.py scans/*.pdf --llm-only          # rules on LLM-extracted fields (unknown layouts)
```

## Live on Base

| | |
|---|---|
| Registry (Base mainnet, chainId 8453) | [`0xF818e4A95BBA02c822bCa8A0CFB50a2Ae4B8eE94`](https://basescan.org/address/0xF818e4A95BBA02c822bCa8A0CFB50a2Ae4B8eE94) |
| Deploy tx | [`0x4d05d7f0…2c4c8`](https://basescan.org/tx/0x4d05d7f02b6e48b2e0f407ccc34537076bfaccec0dcf67e24ccc5e917252c4c8), block 52381146, 2026-10-09 |
| Source verification | [Sourcify, exact match](https://repo.sourcify.dev/8453/0xF818e4A95BBA02c822bCa8A0CFB50a2Ae4B8eE94) (solc 0.8.28, optimizer 200 runs, cancun) |
| Paid lookup API (x402) | `https://buildproof-x402.zbignevich.workers.dev`, $0.01 USDC on Base per call, PayAI facilitator; see [api/README.md](api/README.md) |
| Address book | [`deployments/8453.json`](deployments/8453.json), [`docs/networks.json`](docs/networks.json) |

Demo record on mainnet: the synthetic acceptance act `examples/pdf/act_01.pdf` (sha256 `0x5ce4d832…2db006`) registered as attestation `0xd15075082ba042e12614277aa9f7d6b4769e83020a1d663427a98074f8b39623` with two signers. `0xC628…4F33` signed by transaction, the synthetic contractor `0x7590…7e8F` signed offline (EIP-712) and the signature was relayed. Status: ATTESTED. Transactions: register [`0xeb0df992…`](https://basescan.org/tx/0xeb0df99253a3f3919f9879a197a9ac35c51ef7c1ea93cc4f69da88f40f99b487), sign [`0xc4ae1100…`](https://basescan.org/tx/0xc4ae1100ed0e5f5464d4f69c36d0ab854e266c293206d89117f8843ace746f7f), relay [`0x984d6248…`](https://basescan.org/tx/0x984d624805241b33cb2776ca3cc87731798648dfb18db6962167386009eea763). Deploy plus demo cost 0.0000096 ETH in gas (about $0.024).

```bash
BP_RPC=https://mainnet.base.org node cli/buildproof.mjs verify examples/pdf/act_01.pdf
```

## Deployment

The contract has no constructor arguments and no owner. To deploy on Base Sepolia:

```bash
BP_RPC=https://sepolia.base.org BP_PRIVATE_KEY=... node cli/buildproof.mjs deploy
```

Then add the network to `docs/networks.json` (`name`, `chainId`, `rpc`, `registry`). For source verification without an explorer API key, post the compiler metadata to Sourcify (`POST https://sourcify.dev/server/v2/verify/metadata/<chainId>/<address>`).

## Threat model, design notes and limits

- **Threat Model & Front-Running:** Anyone may register a hash on-chain with any signer list. Front-running a registration with fake signers produces a distinct attestation ID (`realId != fakeId`) because the ID embeds the registrar address and full signers array. Verifiers filter attestations against their list of expected party addresses.
- **EIP-712 Replay & Malleability:** EIP-712 domain separators bind signatures to `block.chainid` and the specific registry contract address. Signatures embed attestation IDs and document hashes, preventing signature reuse across documents, contracts, or chains. Signature malleability is prevented by enforcing upper bounds (`s <= HALF_N`) and rejecting `address(0)`.
- **Privacy & Salt:** Only document SHA-256 hashes go on-chain. Standard hashes of short or low-entropy template documents can potentially be brute-forced. Real construction contracts contain sufficient unique metadata (dates, IBANs, tax IDs, amounts) to prevent dictionary attacks. Salted document hashes are on the roadmap for low-entropy forms.
- **Legal Weight:** A wallet signature is not a Qualified Electronic Signature (QES) under EU eIDAS or US ESIGN regulations. BuildProof functions as an immutable audit trail and tamper-evident evidence layer alongside legally required signatures.
- **Cross-Check Scope:** The rule-based extractor in `crosscheck.py` handles the layout of the bundled examples. For arbitrary layouts, `--llm-only` uses an LLM solely for field extraction, while all compliance logic and arithmetic rules remain 100% deterministic Python.
- **Roadmap:** EAS attestation adapter, salted document hashes, additional legal document templates, subcontractor chain reconciliation.

## AI use

Code, tests and this README were written with the help of Claude (Anthropic). The problem statement and the rules come from the author's daily work. The demo uses NVIDIA-hosted Nemotron for optional field extraction.

## License

[MIT](LICENSE)
