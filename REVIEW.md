# BuildProof Code Review & Hackathon Analysis

**Repository:** `buildproof` (BLI Legal Tech Hackathon 2 entry)
**Review Date:** October 9, 2026
**Branch:** `jules/review-2026-10-09`

---

## Findings Summary Table

| ID | Severity | File : Line | Description | Concrete Fix |
|---|---|---|---|---|
| **FIND-01** | **High** | `contracts/BuildProofRegistry.sol:204` | **Race condition in document supersession:** If two amendments (`SA1` and `SA2`) targeting the same attested contract are registered while `supersededBy[old]` is zero, both pass `register()`. Whichever amendment signs last overwrites `supersededBy[old]`, ignoring the first completed amendment. | In `_sign()`, when `a.signedCount == a.signerCount` and `old != bytes32(0)`, revert with `BadSupersedes(old)` if `supersededBy[old] != bytes32(0)`. |
| **FIND-02** | **Medium** | `cli/buildproof.mjs:125` | **Relayer missing pre-flight validation:** `cmdRelay` sent EIP-712 signatures to the contract without validating if `s.chainId` or `s.registry` matched the connected network, leading to reverted transactions and wasted gas on network mismatches. | Add explicit `s.chainId` and `s.registry` pre-flight equality checks in `cmdRelay` before calling `signBySig()`. |
| **FIND-03** | **Medium** | `checker/crosscheck.py:38` | **Fragile number parser for European locales:** `_num(s)` assumed US formatting (`1,234.56`) by removing all commas. European formatting with decimal commas (`1.234,56` or `1234,56`) caused `ValueError` or incorrect parsing. | Updated `_num(s)` to handle thousand separators (dots, spaces, non-breaking spaces) and decimal commas dynamically. |
| **FIND-04** | **Low** | `docs/app.js:77` | **Potential unescaped string injection in frontend DOM:** While `app.js` used an `esc()` helper for most variables, fallback values (e.g. `DOC_TYPES[Number(a.docType)] || a.docType`) or raw party mappings could inject unescaped text into `.innerHTML`. | Wrapped all dynamic contract outputs and fallback strings in `esc()` before HTML insertion. |
| **FIND-05** | **Low** | `checker/crosscheck.py:90` | **Prompt injection vulnerability in LLM extraction:** Raw PDF text is directly appended to `LLM_PROMPT`. An adversarial PDF containing system prompt overrides could alter extracted JSON fields. | Documented threat model: deterministic rules and regex-vs-LLM field diff comparison (`compare_extractions`) raise warnings when extractions disagree, preventing undetected overrides. |
| **FIND-06** | **Info** | `contracts/BuildProofRegistry.sol:185` | **Domain separator chain fork safety vs gas:** `domainSeparator()` recomputes `block.chainid` dynamically on every view call. This ensures 100% chain-fork safety but incurs dynamic hashing cost during signature verification. | Kept dynamic domain separator calculation as a safe default; cached domain separator can be considered if gas minimization becomes critical. |
| **FIND-07** | **Info** | `contracts/BuildProofRegistry.sol:123` | **Registration front-running / hash clutter:** Anyone can register any hash with fake signers. Because `id` includes `msg.sender` and `signers`, front-running does not block the real signers, but `_byHash[docHash]` accumulates multiple attestation records. | Verifiers must filter attestations by expected party addresses (implemented in CLI and UI). |

---

## Detailed Analysis by Category

### A. EIP-712 Signatures
- **Domain Separator (`contracts/BuildProofRegistry.sol:185`):** Uses `keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)))`. Dynamically reading `block.chainid` guarantees safety across chain hard forks.
- **Typehash String (`contracts/BuildProofRegistry.sol:39`):** `SIGN_TYPEHASH = keccak256("Sign(bytes32 attestationId,bytes32 docHash)")`. Matches EIP-712 definitions in `cli/abi.mjs` and `docs/app.js`.
- **Replay Protection & Malleability:**
  - `signDigest` includes `id` (which embeds docHash, docType, projectRef, supersedes, signers list, and registrar) and `docHash`.
  - Signature recovery uses `_recover()` with ECDSA malleable `s` protection (`uint256(s) <= HALF_N`) and checks `who != address(0)`.
  - Once signed, state changes from `1` (awaiting) to `2` (signed), preventing double signing or reuse across documents/actions.

### B. Access Control and State Machine
- **Registration (`contracts/BuildProofRegistry.sol:84`):** Open to any `msg.sender`. Trust is derived from the `signers` list. Duplicate signers, zero addresses, empty signer lists, and lists exceeding `MAX_SIGNERS` (16) revert.
- **State Machine:**
  - Attestation status transitions from `Pending` -> `Attested` (when `signedCount == signerCount`) or `Rejected` (when any required signer calls `reject()`).
  - Once `Attested` or `Rejected`, further signatures or rejections revert with `NotPending`.
- **Supersession Race Condition (Fixed in FIND-01):** When an amendment becomes fully attested, `supersededBy[old]` is updated. If two pending amendments existed, the second one completing attestation previously overwrote `supersededBy[old]` without checking if it was already set. Added check `if (supersededBy[old] != bytes32(0)) revert BadSupersedes(old);`.

### C. Tests
- Added Foundry test `test_RevertWhen_SecondPendingAmendmentAttested()` in `test/BuildProofRegistry.t.sol` to verify supersession race protection.
- Added `test_num_formatting()` in `checker/tests/test_crosscheck.py` to verify European number formatting parsing.

### D. CLI and Verification Page
- **CLI (`cli/buildproof.mjs`):** `toHash()` uses SHA-256 matching browser WebCrypto `crypto.subtle.digest("SHA-256", ...)`. `cmdRelay` now validates `s.chainId` and `s.registry` pre-flight.
- **Verification Page (`docs/app.js`):** Client-side hashing via WebCrypto ensures documents are never transmitted over the network. Network switching connects securely via JSON-RPC. Escaped user inputs protect against DOM XSS.

### E. Cross-Check (`checker/crosscheck.py`)
- Deterministic Python rules execute arithmetic checks (subtotals, line math, VAT, totals), date bounds, and cumulative volume caps.
- LLM prompt extraction is strictly isolated: the LLM extracts JSON fields, and deterministic Python code evaluates all rules. Field diffs between regex and LLM extractions raise `EXTRACTION_DISAGREES` warnings.

---

## Weak Points a Hackathon Judge Will Notice

1. **Legal Weight of On-Chain Hash:**
   - *Challenge:* An EVM hash transaction or EIP-712 signature is not a Qualified Electronic Signature (eIDAS in EU, ESIGN in US).
   - *Answer:* BuildProof is designed as an immutable **audit trail & evidence layer**, not a legal signature substitute. It proves *exact document state* at a point in time, preventing post-hoc document alteration disputes.
2. **Privacy & Hash Brute-Forcing:**
   - *Challenge:* Standard SHA-256 hashes of predictable or low-entropy document templates can be brute-forced or reverse-searched on-chain.
   - *Answer:* Real construction contracts contain high-entropy metadata (dates, IBANs, amounts, company registration numbers). A salted document hash mode is documented on the roadmap for low-entropy templates.
3. **Custom Smart Contract vs. EAS (Ethereum Attestation Service):**
   - *Challenge:* Why deploy a custom registry contract instead of using standard EAS schemas?
   - *Answer:* Custom contract logic provides atomic multi-party quorum status (`Pending` -> `Attested` -> `Superseded`), on-chain rejection with reason hash, and EIP-712 signature relaying in a single lightweight interface tailored to construction workflows. An EAS adapter is planned for interoperability.
4. **Local Anvil vs. Public Testnet Deployment:**
   - *Challenge:* Demo defaults to local `anvil` chain instead of a live testnet.
   - *Answer:* The CLI and frontend fully support any EVM RPC (`docs/networks.json`). Local `anvil` provides instant, reliable end-to-end demo execution during evaluation without requiring testnet faucet ETH.

---

## README Improvements

1. **Clean Clone Quick-Start:**
   - Explicitly document Foundry installation steps (`foundryup` / `forge`) and Python dependency setup (`pip install pypdf reportlab pytest`).
2. **Threat Model & Security Design:**
   - Clarify front-running resilience: registrar addresses in attestation IDs prevent griefing DoS, and verifiers check signer addresses against expected party lists.
3. **Honest Scope & Limitations:**
   - Explicitly state that BuildProof does not replace statutory legal signatures and does not upload confidential document contents on-chain.
