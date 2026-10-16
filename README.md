# BuildProof

**Verifiable, tamper-evident attestations for legal documents and AI-generated legal outputs: multi-party wallet signatures on-chain (EIP-712, gasless relay), deterministic pre-signing checks, and a pay-per-verify API for AI agents (x402).**

Built for the [BLI Legal Tech Hackathon 2](https://dorahacks.io/hackathon/legal-hack-2026/detail), tracks *LegalTech & RegTech* and *AI x Blockchain*.

> Status: **prototype, unaudited.** The registry, the verify page and the paid x402 API run on Base mainnet, but every record there is a demo with synthetic documents and there are no external users yet; see [Live on Base](#live-on-base). Every transaction the CLI sends carries BuildProof's Base Builder Code (ERC-8021).

## Check it in 2 minutes

1. **Open the verify page:** https://ttimesai-star.github.io/buildproof/ and use the three buttons under *Try it in one click*. Each one downloads a sample file, hashes it in your browser and looks the hash up on Base mainnet:
   - *Signed acceptance act*: `Attested by all 2 signers` and `Signers match your list`, with registration and completion times from the chain;
   - *Same act, one amount changed* (23,600.00 → 28,600.00, one byte): `Not found`;
   - *AI legal review, approved by a human*: an AI-output manifest that became `ATTESTED` only after the human reviewer co-signed.

   You can also drop any of your own files there: nothing is uploaded, only the hash is sent to the RPC node.
2. **Watch the demo video** (2 min 47 s, narrated): [demo.mp4](https://ttimesai-star.github.io/buildproof/demo.mp4).
3. **Ask the paid API as an agent would** (no wallet needed to see the price):
   ```bash
   curl -i https://buildproof-x402.zbignevich.workers.dev/v1/attestation/0x5ce4d8327a23f4fa5c5e0bcc551f22ecc9285b36b5aab25eb4b9093ac92db006
   # HTTP/1.1 402 Payment Required + PAYMENT-REQUIRED header: 10000 units of USDC (= $0.01) on Base (eip155:8453)
   ```
4. **Check the contract:** [Basescan](https://basescan.org/address/0xF818e4A95BBA02c822bCa8A0CFB50a2Ae4B8eE94) and [Sourcify exact match](https://repo.sourcify.dev/8453/0xF818e4A95BBA02c822bCa8A0CFB50a2Ae4B8eE94) of [contracts/BuildProofRegistry.sol](contracts/BuildProofRegistry.sol).
5. **Run everything locally** (Foundry, Node 18+, Python 3.10+): `bash scripts/demo.sh` for the 10-step story on a local chain, `npm test` for all tests. CI runs both on every push.

## Why it matters legally

Disputes over documents are usually not about what the law says but about *which file* is the one the parties agreed to. US evidence rules already accept a matching hash as the ordinary way to show that a copy is identical to the original, and the main e-signature laws do not deny legal effect to electronic records. BuildProof turns that into a shared, timestamped record that every party can check without trusting the others.

- **US Federal Rules of Evidence, Rule 902(14)** makes data copied from an electronic file self-authenticating when it is "authenticated by a process of digital identification", certified by a qualified person. The Advisory Committee note: "data copied from electronic devices, storage media, and electronic files are ordinarily authenticated by 'hash value'... If the hash values for the original and copy are different, then the copy is not identical to the original." BuildProof records which hash each party approved and when; the certification itself is still done by a person.
- **US ESIGN Act, 15 U.S.C. § 7001(a)(1):** a signature, contract or other record "may not be denied legal effect, validity, or enforceability solely because it is in electronic form". **Arizona, A.R.S. § 44-7061(A)-(B):** a signature or record "secured through blockchain technology" is an electronic signature or electronic record.
- **EU eIDAS Regulation (EU) No 910/2014, Article 25:** an electronic signature "shall not be denied legal effect and admissibility as evidence in legal proceedings solely on the grounds that it is in an electronic form or that it does not meet the requirements for qualified electronic signatures"; only a *qualified* electronic signature has the effect of a handwritten one (Art. 25(2)).

What this means for BuildProof, stated plainly: a wallet signature is an ordinary electronic signature, not a qualified one (QES). Use BuildProof as the evidence and audit layer next to whatever signature the contract or local law requires, not instead of it. This is a description of the product, not legal advice for any jurisdiction.

## Legal use cases

BuildProof provides an immutable, hash-only audit trail and multi-party attestation layer for legal and compliance operations. Content remains private off-chain while party approval and document lineage are proven on-chain.

- **Contract and amendment chains (`supersededBy`):** Main contracts linked to supplementary agreements; once an amendment is attested, the original record shows as superseded.
- **NDAs and engagement letters:** Multi-party execution via wallet transactions or gasless EIP-712 signatures.
- **Acceptance acts and invoices:** Pre-signing checks verify arithmetic, rates, cumulative volumes, and party details before registration.
- **AI-generated legal outputs:** A canonical manifest combines model ID, prompt SHA-256, input document SHA-256 array, and output SHA-256. Co-signed by an AI operator and a human reviewer, it proves which exact output a lawyer approved and guarantees it was not edited afterwards.
- **Evidence bundles for disputes and arbitration:** Timestamped SHA-256 fingerprints recorded on-chain while sensitive evidence files remain strictly private.
- **KYC and compliance file custody:** Hash-only proof of file state at a point in time without putting personal data on-chain.

BuildProof complements legally required signatures and serves as tamper-evident evidence layer; see [Legal Weight](#threat-model-design-notes-and-limits) for regulatory scope.

### NDA and AI-output attestation workflow

```bash
# Register and co-sign a mutual NDA
BP_PRIVATE_KEY=... node cli/buildproof.mjs register examples/legal/nda_mutual.pdf \
  --type nda --project LEGAL-2026 --signers 0xPartyA,0xPartyB

# Build a canonical review manifest for AI legal output
node cli/buildproof.mjs manifest --model gpt-4o \
  --prompt examples/legal/ai_review_prompt.txt \
  --input examples/legal/nda_mutual.pdf \
  --output examples/legal/ai_review_output.md \
  --created 2026-10-09 > examples/legal/ai_review_manifest.json

# Register manifest on-chain for AI operator and human reviewer
BP_PRIVATE_KEY=... node cli/buildproof.mjs register examples/legal/ai_review_manifest.json \
  --type ai-output --project LEGAL-2026 --signers 0xOperator,0xReviewer

# Verify any file or manifest hash
node cli/buildproof.mjs verify examples/legal/ai_review_manifest.json
```

## Worked example: construction contracts and acceptance acts

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
- **CLI** ([cli/buildproof.mjs](cli/buildproof.mjs)): `hash`, `manifest`, `deploy`, `register`, `sign`, `sign-offline`, `relay`, `reject`, `status`, `verify`.
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
forge test                                                # 21 tests including fuzzing: signatures, replay, malleability, griefing, amendments
python checker/tests/test_crosscheck.py                   # the cross-check finds exactly the planted problems and nothing else
node --test api/test/api.test.mjs                         # x402 API: 402 price list, paid lookups on a live anvil registry, refused bad payments
node --test api/test/near.test.mjs                        # NEAR AI Agent Market backend: brief parsing, webhook HMAC, submit/decline
node --test api/test/openserv.test.mjs                    # OpenServ x402 marketplace agent endpoint
node --test cli/test/attribution.test.mjs cli/test/legal.test.mjs cli/test/samples.test.mjs # ERC-8021 suffix, legal use cases (NDA, AI-output manifests), verify-page samples pinned to the mainnet records
```

## CLI reference

```bash
node cli/buildproof.mjs hash examples/pdf/act_01.pdf
node cli/buildproof.mjs manifest --model gpt-4o --prompt p.txt --input nda.pdf --output out.md --created 2026-10-09
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

Demo video (2 min 47 s, synthetic narration, captioned): [ttimesai-star.github.io/buildproof/demo.mp4](https://ttimesai-star.github.io/buildproof/demo.mp4). It records the live verify page against the mainnet registry (signed act, tampered copy, human-approved AI review), the cross-check, the live x402 quote and the legal scope. The voice is text-to-speech (Microsoft Edge neural voice); the script that records it is [scripts/video/make_video.py](scripts/video/make_video.py). The first, silent 57-second version is kept as [demo_v1_silent.mp4](https://ttimesai-star.github.io/buildproof/demo_v1_silent.mp4).

| | |
|---|---|
| Registry (Base mainnet, chainId 8453) | [`0xF818e4A95BBA02c822bCa8A0CFB50a2Ae4B8eE94`](https://basescan.org/address/0xF818e4A95BBA02c822bCa8A0CFB50a2Ae4B8eE94) |
| Deploy tx | [`0x4d05d7f0…2c4c8`](https://basescan.org/tx/0x4d05d7f02b6e48b2e0f407ccc34537076bfaccec0dcf67e24ccc5e917252c4c8), block 52381146, 2026-10-09 |
| Source verification | [Sourcify, exact match](https://repo.sourcify.dev/8453/0xF818e4A95BBA02c822bCa8A0CFB50a2Ae4B8eE94) (solc 0.8.28, optimizer 200 runs, cancun) |
| Paid lookup API (x402) | `https://buildproof-x402.zbignevich.workers.dev`, $0.01 USDC on Base per call, PayAI facilitator; see [api/README.md](api/README.md) |
| NEAR AI Agent Market | agent [`buildproof`](https://market.near.ai/a/buildproof), A2A + x402, $0.01 USDC on NEAR per call; see [api/README.md](api/README.md#listed-on-the-near-ai-agent-market-a2a--x402) |
| Address book | [`deployments/8453.json`](deployments/8453.json), [`docs/networks.json`](docs/networks.json) |

Demo record on mainnet: the synthetic acceptance act `examples/pdf/act_01.pdf` (sha256 `0x5ce4d832…2db006`) registered as attestation `0xd15075082ba042e12614277aa9f7d6b4769e83020a1d663427a98074f8b39623` with two signers. `0xC628…4F33` signed by transaction, the synthetic contractor `0x7590…7e8F` signed offline (EIP-712) and the signature was relayed. Status: ATTESTED. Transactions: register [`0xeb0df992…`](https://basescan.org/tx/0xeb0df99253a3f3919f9879a197a9ac35c51ef7c1ea93cc4f69da88f40f99b487), sign [`0xc4ae1100…`](https://basescan.org/tx/0xc4ae1100ed0e5f5464d4f69c36d0ab854e266c293206d89117f8843ace746f7f), relay [`0x984d6248…`](https://basescan.org/tx/0x984d624805241b33cb2776ca3cc87731798648dfb18db6962167386009eea763). Deploy plus demo cost 0.0000096 ETH in gas (about $0.024).

```bash
BP_RPC=https://mainnet.base.org node cli/buildproof.mjs verify examples/pdf/act_01.pdf
```

AI-output manifest on mainnet: the synthetic review manifest `examples/legal/ai_review_manifest.json` (sha256 `0x60728c3f…7b8bc8`, type `ai-output`, project `LEGAL-2026`) registered as attestation `0x87580bfb0353da1df37d935220f0ead6388d550fa3d06571d9210abab26ad12e` with two required signers: the AI operator `0x7590…7e8F` (demo key, signed offline with EIP-712, signature relayed) and the human reviewer `0xC628…4F33` (signed by transaction). Status: ATTESTED, 2026-10-10. Transactions: register [`0x38c7eef6…`](https://basescan.org/tx/0x38c7eef6b030704a2601a6987146162a0339d5bd0f91c7a6ecadf7da288ccad0), relay (AI operator) [`0x8662ee13…`](https://basescan.org/tx/0x8662ee133deb3a748bacd017a5b78670899b88789b511790224da2f99e751a2d), sign (human reviewer) [`0xf779a3e5…`](https://basescan.org/tx/0xf779a3e5def5a81b440c69c5aadba8a9eaa5a6e2b0d9aac3d0319f1d86f4b25d). Gas for all three: 0.0000021930 ETH (about $0.005).

```bash
BP_RPC=https://mainnet.base.org node cli/buildproof.mjs verify examples/legal/ai_review_manifest.json
```

### Builder Code (ERC-8021)

BuildProof is registered on [Base Dashboard](https://dashboard.base.org/) with the Builder Code `bc_a97tmthu`. The CLI appends the ERC-8021 suffix `0x62635f613937746d7468750b0080218021802180218021802180218021` to the calldata of `register`, `sign`, `relay` (signBySig) and `reject` ([cli/attribution.mjs](cli/attribution.mjs)). The registry ignores trailing calldata, so nothing changed on-chain. Set `BP_BUILDER_CODE` to use other codes, or `none` to send without one. Deployment transactions do not carry the suffix: trailing bytes after the init code would change the creation input that Sourcify matches.

First attributed transactions (synthetic contract `examples/pdf/contract_GC-2026-014.pdf`, attestation `0xf9499d3b…487efd`, ATTESTED): register [`0x04f69900…`](https://basescan.org/tx/0x04f69900d5eef771025baa80dcabfa0daf32fe0d160abd21895a9a5c70bbb209), sign [`0x21823c26…`](https://basescan.org/tx/0x21823c2636f85c03532a6acb4b84855ac82841205c51d9ec08f0f7cbbbd63434). Both show as "8021 Attributed", code `bc_a97tmthu`, in the [Builder Code checker](https://builder-code-checker.vercel.app/).

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
- **Legal Weight:** A wallet signature is an ordinary electronic signature: under EU eIDAS it is not a qualified electronic signature (QES), and US ESIGN only guarantees it is not refused *solely* because it is electronic. BuildProof functions as an immutable audit trail and tamper-evident evidence layer alongside legally required signatures; see [Why it matters legally](#why-it-matters-legally).
- **Cross-Check Scope:** The rule-based extractor in `crosscheck.py` handles the layout of the bundled examples. For arbitrary layouts, `--llm-only` uses an LLM solely for field extraction, while all compliance logic and arithmetic rules remain 100% deterministic Python.
- **Roadmap:** EAS attestation adapter, salted document hashes, additional legal document templates, subcontractor chain reconciliation.

## AI use

Code, tests and this README were written with the help of Claude (Anthropic). The problem statement and the rules come from the author's daily work. The demo uses NVIDIA-hosted Nemotron for optional field extraction.

## License

[MIT](LICENSE)
