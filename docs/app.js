/* BuildProof verify page. Plain JS + ethers v6 UMD. Keep ABI in sync with cli/abi.mjs. */
const ABI = [
  "function getAttestation(bytes32 id) view returns (tuple(bytes32 docHash, bytes32 projectRef, bytes32 supersedes, address registrar, uint64 registeredAt, uint64 closedAt, uint8 docType, uint8 status, uint16 signerCount, uint16 signedCount))",
  "function getSigners(bytes32 id) view returns (address[] signers, uint8[] states)",
  "function attestationsOf(bytes32 docHash) view returns (bytes32[])",
  "function supersededBy(bytes32 id) view returns (bytes32)",
];
const DOC_TYPES = ["other", "contract", "supplementary agreement", "acceptance act", "as-built documentation", "invoice"];
const STATUS = ["none", "pending", "attested", "rejected"];
const SIGNER_STATE = ["-", "awaiting signature", "signed", "rejected"];
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ZERO = "0x" + "0".repeat(64);
let networks = [];

async function loadNetworks() {
  try { networks = await (await fetch("networks.json", { cache: "no-store" })).json(); } catch { networks = []; }
  networks.push({ name: "Local anvil (31337)", chainId: 31337, rpc: "http://127.0.0.1:8545", registry: "0x5FbDB2315678afecb367f032d93F642f64180aa3", note: "Run scripts/demo.sh first; the demo deploys to this address." });
  $("net").innerHTML = networks.map((n, i) => `<option value="${i}">${esc(n.name)}</option>`).join("");
  const q = new URLSearchParams(location.search);
  const pick = () => {
    const n = networks[$("net").value];
    $("rpc").value = n.rpc; $("reg").value = n.registry || ""; $("netnote").textContent = n.note || "";
  };
  $("net").onchange = pick; pick();
  if (q.get("hash")) { $("hash").value = q.get("hash"); verify(); }
}

async function sha256(file) {
  const buf = await file.arrayBuffer();
  const d = await crypto.subtle.digest("SHA-256", buf);
  return "0x" + [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parties() {
  const m = new Map();
  for (const line of $("parties").value.split(/\n/)) {
    const t = line.trim().match(/^(0x[0-9a-fA-F]{40})\s*(.*)$/);
    if (t) m.set(ethers.getAddress(t[1]), t[2] || "expected signer");
  }
  return m;
}

async function rpcChainId(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    return Number((await r.json()).result);
  } catch { throw new Error(`RPC ${url} is not reachable. For "Local anvil" run scripts/demo.sh on this computer first.`); }
  finally { clearTimeout(t); }
}

async function makeProvider() {
  const url = $("rpc").value.trim();
  const chainId = await rpcChainId(url);
  return new ethers.JsonRpcProvider(url, chainId, { staticNetwork: true });
}

const when = (t) => (Number(t) ? new Date(Number(t) * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC") : "-");

async function verify() {
  const out = $("result");
  const hash = $("hash").value.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) { out.innerHTML = `<div class="card bad">Enter a file or a 0x-prefixed 64-hex SHA-256 hash.</div>`; return; }
  out.innerHTML = `<div class="card muted">Looking up ${esc(hash)}...</div>`;
  try {
    const provider = await makeProvider();
    if ((await provider.getCode($("reg").value.trim())) === "0x") throw new Error("No registry contract at this address on this network.");
    const reg = new ethers.Contract($("reg").value.trim(), ABI, provider);
    const ids = await reg.attestationsOf(hash);
    const known = parties();
    if (!ids.length) {
      out.innerHTML = `<div class="card"><span class="badge bad">Not found</span>
        <p>No attestation exists for these exact bytes. If you expected one, the file you hold differs from the one the parties signed (a single changed byte gives a different hash), or it was registered on another network.</p>
        <p class="mono">${esc(hash)}</p></div>`;
      return;
    }
    let html = `<p class="muted">${ids.length} record(s) for this hash. Trust a record only if its signers are the parties you expect.</p>`;
    for (const id of ids) {
      const a = await reg.getAttestation(id);
      const [signers, states] = await reg.getSigners(id);
      const next = await reg.supersededBy(id);
      const st = Number(a.status);
      const allKnown = known.size > 0 && signers.every((s) => known.has(ethers.getAddress(s)));
      let badge = st === 2 ? `<span class="badge ok">Attested by all ${signers.length} signers</span>`
        : st === 3 ? `<span class="badge bad">Rejected by a signer</span>`
        : `<span class="badge warn">Pending: ${a.signedCount} of ${a.signerCount} signed</span>`;
      if (next !== ZERO) badge += ` <span class="badge warn">Amended later</span>`;
      if (known.size) badge += allKnown ? ` <span class="badge ok">Signers match your list</span>` : ` <span class="badge bad">Unknown signers</span>`;
      const rows = signers.map((s, i) => `<tr><td>signer</td><td><span class="mono">${esc(s)}</span>${known.has(ethers.getAddress(s)) ? " - " + esc(known.get(ethers.getAddress(s))) : ""}<br><span class="muted">${SIGNER_STATE[Number(states[i])]}</span></td></tr>`).join("");
      html += `<div class="card">${badge}
        <table style="margin-top:10px">
          <tr><td>document type</td><td>${esc(DOC_TYPES[Number(a.docType)] || a.docType)}</td></tr>
          <tr><td>registered</td><td>${when(a.registeredAt)} by <span class="mono">${esc(a.registrar)}</span></td></tr>
          <tr><td>${st === 3 ? "rejected" : "completed"}</td><td>${when(a.closedAt)}</td></tr>
          ${rows}
          ${a.supersedes !== ZERO ? `<tr><td>amends</td><td class="mono">${esc(a.supersedes)}</td></tr>` : ""}
          ${next !== ZERO ? `<tr><td>amended by</td><td class="mono">${esc(next)}</td></tr>` : ""}
          <tr><td>attestation id</td><td class="mono">${esc(id)}</td></tr>
        </table></div>`;
    }
    out.innerHTML = html;
  } catch (e) {
    out.innerHTML = `<div class="card"><span class="badge bad">Lookup failed</span><p class="mono">${esc(e.shortMessage || e.message)}</p><p class="muted">Check the network, RPC URL and registry address.</p></div>`;
  }
}

async function signAsParty() {
  const out = $("sigout");
  try {
    if (!window.ethereum) throw new Error("No browser wallet found (e.g. MetaMask).");
    const id = $("sid").value.trim();
    const bp = new ethers.BrowserProvider(window.ethereum);
    const signer = await bp.getSigner();
    const { chainId } = await bp.getNetwork();
    const regAddr = $("reg").value.trim();
    const reg = new ethers.Contract(regAddr, ABI, await makeProvider());
    const a = await reg.getAttestation(id);
    if (Number(a.status) !== 1) throw new Error("This attestation is not pending.");
    if ($("hash").value.trim() && $("hash").value.trim().toLowerCase() !== a.docHash.toLowerCase())
      throw new Error("The file you checked above does NOT match this attestation. Do not sign.");
    const domain = { name: "BuildProof", version: "1", chainId, verifyingContract: regAddr };
    const types = { Sign: [{ name: "attestationId", type: "bytes32" }, { name: "docHash", type: "bytes32" }] };
    const signature = await signer.signTypedData(domain, types, { attestationId: id, docHash: a.docHash });
    out.textContent = JSON.stringify({ attestationId: id, docHash: a.docHash, signer: await signer.getAddress(), signature, chainId: Number(chainId), registry: regAddr }, null, 2);
  } catch (e) {
    out.textContent = "Error: " + (e.shortMessage || e.message);
  }
}

$("drop").onclick = () => $("file").click();
$("drop").onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") $("file").click(); };
$("drop").ondragover = (e) => { e.preventDefault(); $("drop").classList.add("over"); };
$("drop").ondragleave = () => $("drop").classList.remove("over");
$("drop").ondrop = async (e) => { e.preventDefault(); $("drop").classList.remove("over"); if (e.dataTransfer.files[0]) { $("hash").value = await sha256(e.dataTransfer.files[0]); verify(); } };
$("file").onchange = async () => { if ($("file").files[0]) { $("hash").value = await sha256($("file").files[0]); verify(); } };
$("go").onclick = verify;
$("signbtn").onclick = signAsParty;
loadNetworks();
