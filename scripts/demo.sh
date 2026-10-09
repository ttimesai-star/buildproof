#!/usr/bin/env bash
# BuildProof end-to-end demo on a local anvil chain (or any RPC via BP_RPC + funded keys).
# Needs: foundry (forge, anvil), node >= 18, python 3 with pypdf + reportlab.
# The three keys below are anvil's PUBLIC default dev keys. Never use them on a real network.
set -euo pipefail
cd "$(dirname "$0")/.."

RELAYER=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80     # 0xf39F...2266, pays gas
CLIENT=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d      # 0x7099...79C8
CONTRACTOR=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a  # 0x3C44...93BC
CLIENT_ADDR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
CONTRACTOR_ADDR=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
export BP_RPC=${BP_RPC:-http://127.0.0.1:8545}
BP="node cli/buildproof.mjs"
OUT=demo-out
mkdir -p "$OUT"
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

ANVIL_PID=""
if ! curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$BP_RPC" >/dev/null 2>&1; then
  step "starting a local anvil chain"
  anvil --silent & ANVIL_PID=$!
  trap '[ -n "$ANVIL_PID" ] && kill $ANVIL_PID' EXIT
  for _ in $(seq 1 30); do curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$BP_RPC" >/dev/null 2>&1 && break; sleep 0.5; done
fi

step "1. build the contract and render the synthetic documents"
forge build --silent
python examples/make_examples.py
printf '{"%s":"Client (Alder Street Development)","%s":"Contractor (Granite & Beam)"}\n' "$CLIENT_ADDR" "$CONTRACTOR_ADDR" > "$OUT/parties.json"

step "2. AI cross-check BEFORE anyone signs (contract + agreement + 3 acts)"
python checker/crosscheck.py examples/pdf/contract_GC-2026-014.pdf examples/pdf/supplementary_agreement_01.pdf \
  examples/pdf/act_01.pdf examples/pdf/act_02.pdf examples/pdf/act_03.pdf --json "$OUT/crosscheck.json" || true

step "3. deploy the registry"
BP_PRIVATE_KEY=$RELAYER $BP deploy

step "4. contract: client signs directly, contractor signs offline (EIP-712), a relayer submits it"
C_ID=$(BP_PRIVATE_KEY=$CLIENT $BP register examples/pdf/contract_GC-2026-014.pdf --type contract --project PLOT-7 --signers $CLIENT_ADDR,$CONTRACTOR_ADDR)
BP_PRIVATE_KEY=$CLIENT $BP sign "$C_ID" >/dev/null
BP_PRIVATE_KEY=$CONTRACTOR $BP sign-offline "$C_ID" --file examples/pdf/contract_GC-2026-014.pdf --out "$OUT/contractor_sig.json"
BP_PRIVATE_KEY=$RELAYER $BP relay "$OUT/contractor_sig.json"

step "5. supplementary agreement no. 1 amends the contract"
SA_ID=$(BP_PRIVATE_KEY=$CLIENT $BP register examples/pdf/supplementary_agreement_01.pdf --type supplementary-agreement --project PLOT-7 --supersedes "$C_ID" --signers $CLIENT_ADDR,$CONTRACTOR_ADDR)
BP_PRIVATE_KEY=$CLIENT $BP sign "$SA_ID" >/dev/null
BP_PRIVATE_KEY=$CONTRACTOR $BP sign "$SA_ID" | sed -n '1,3p'

step "6. act no. 1 passed the cross-check: both parties sign"
A1_ID=$(BP_PRIVATE_KEY=$CONTRACTOR $BP register examples/pdf/act_01.pdf --type acceptance-act --project PLOT-7 --signers $CLIENT_ADDR,$CONTRACTOR_ADDR)
BP_PRIVATE_KEY=$CONTRACTOR $BP sign "$A1_ID" >/dev/null
BP_PRIVATE_KEY=$CLIENT $BP sign "$A1_ID" | sed -n '1,3p'

step "7. act no. 2 failed the cross-check: contractor signed, client rejects with the report hash"
A2_ID=$(BP_PRIVATE_KEY=$CONTRACTOR $BP register examples/pdf/act_02.pdf --type acceptance-act --project PLOT-7 --signers $CLIENT_ADDR,$CONTRACTOR_ADDR)
BP_PRIVATE_KEY=$CONTRACTOR $BP sign "$A2_ID" >/dev/null
BP_PRIVATE_KEY=$CLIENT $BP reject "$A2_ID" --reason "$OUT/crosscheck.json"

step "8. anyone verifies by file: original act no. 1"
$BP verify examples/pdf/act_01.pdf --parties "$OUT/parties.json"

step "9. ...and a copy with ONE byte changed"
python - <<'PY'
src = open("examples/pdf/act_01.pdf", "rb").read()
i = src.find(b"23600.00")
assert i > 0, "amount not found in the PDF stream"
open("demo-out/act_01_tampered.pdf", "wb").write(src[:i] + b"28600.00" + src[i + 8:])
PY
$BP verify "$OUT/act_01_tampered.pdf" || true

step "10. the original contract now shows it was amended"
$BP verify examples/pdf/contract_GC-2026-014.pdf --parties "$OUT/parties.json"

step "done"
echo "registry: $(node -e "const f=require('fs');const d=f.readdirSync('deployments').map(x=>JSON.parse(f.readFileSync('deployments/'+x)));console.log(d.map(x=>x.chainId+':'+x.address).join(' '))")"
