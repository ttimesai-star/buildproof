#!/usr/bin/env node
// BuildProof CLI. Run `node cli/buildproof.mjs help`.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { ABI, DOC_TYPES, STATUS, SIGNER_STATE, SIGN_TYPES, domainFor } from "./abi.mjs";
import { sendAttributed } from "./attribution.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const HELP = `buildproof <command> [options]

  hash <file>                                  SHA-256 of the exact file bytes
  deploy                                       deploy BuildProofRegistry, save deployments/<chainId>.json
  register <file> --type <t> --signers a,b     register a document; prints the attestation id
           [--project <ref>] [--supersedes <id>]
  sign <id>                                    sign as the key's address (sends a transaction)
  sign-offline <id> --out sig.json             EIP-712 signature only, no gas needed
  relay <sig.json>                             submit someone's offline signature
  reject <id> --reason <file>                  refuse to sign; records sha256(reason file)
  status <id>                                  show one attestation
  verify <file|0xhash> [--parties p.json]      look a document up by hash

options: --rpc <url> (env BP_RPC, default http://127.0.0.1:8545)
         --registry <address> (env BP_REGISTRY, else deployments/<chainId>.json)
         --key-env <NAME> env var that holds the private key (default BP_PRIVATE_KEY)
         env BP_BUILDER_CODE: ERC-8021 builder code(s) appended to tx calldata
           (default bc_a97tmthu, BuildProof's Base Builder Code; "none" disables)
types:   ${DOC_TYPES.join(", ")}`;

function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) opt[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[++i];
    else pos.push(argv[i]);
  }
  return { pos, opt };
}

export function sha256File(path) {
  return "0x" + createHash("sha256").update(readFileSync(path)).digest("hex");
}

const isHash = (s) => /^0x[0-9a-fA-F]{64}$/.test(s || "");
const toHash = (s) => (isHash(s) ? s : sha256File(s));
const projectRef = (s) => (!s ? ethers.ZeroHash : isHash(s) ? s : ethers.id(s));
const fmtTime = (t) => (Number(t) ? new Date(Number(t) * 1000).toISOString().replace(".000Z", "Z") : "-");

async function ctx(opt, needKey = false) {
  const provider = new ethers.JsonRpcProvider(opt.rpc || process.env.BP_RPC || "http://127.0.0.1:8545");
  const { chainId } = await provider.getNetwork();
  let wallet = null;
  if (needKey) {
    const name = opt["key-env"] || "BP_PRIVATE_KEY";
    const pk = process.env[name];
    if (!pk) throw new Error(`env ${name} is empty: put the signer's private key there`);
    wallet = new ethers.Wallet(pk, provider);
  }
  let address = opt.registry || process.env.BP_REGISTRY;
  const depFile = join(ROOT, "deployments", `${chainId}.json`);
  if (!address && existsSync(depFile)) address = JSON.parse(readFileSync(depFile, "utf8")).address;
  const registry = address ? new ethers.Contract(address, ABI, wallet || provider) : null;
  return { provider, chainId, wallet, registry, address, depFile };
}

const need = (registry) => {
  if (!registry) throw new Error("no registry address: run `deploy` or pass --registry");
  return registry;
};

async function cmdDeploy(opt) {
  const c = await ctx(opt, true);
  const art = join(ROOT, "out", "BuildProofRegistry.sol", "BuildProofRegistry.json");
  if (!existsSync(art)) throw new Error("artifact missing: run `forge build` first");
  const j = JSON.parse(readFileSync(art, "utf8"));
  const f = new ethers.ContractFactory(j.abi, j.bytecode.object, c.wallet);
  const r = await f.deploy();
  const tx = r.deploymentTransaction();
  await r.waitForDeployment();
  const rec = await tx.wait();
  const out = { chainId: Number(c.chainId), address: await r.getAddress(), deployTx: tx.hash, block: rec.blockNumber, deployer: c.wallet.address };
  mkdirSync(dirname(c.depFile), { recursive: true });
  writeFileSync(c.depFile, JSON.stringify(out, null, 2) + "\n");
  console.log(`BuildProofRegistry ${out.address} on chain ${out.chainId} (tx ${tx.hash})`);
}

async function cmdRegister(file, opt) {
  const c = await ctx(opt, true);
  const reg = need(c.registry);
  const docHash = toHash(file);
  const type = DOC_TYPES.indexOf(opt.type || "other");
  if (type < 0) throw new Error("unknown --type");
  if (!opt.signers) throw new Error("--signers a,b is required");
  const signers = String(opt.signers).split(",").map((s) => ethers.getAddress(s.trim()));
  const supersedes = opt.supersedes ? opt.supersedes : ethers.ZeroHash;
  const tx = await sendAttributed(reg, "register", [docHash, type, projectRef(opt.project), supersedes, signers]);
  const rec = await tx.wait();
  const ev = rec.logs.map((l) => { try { return reg.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Registered");
  console.log(ev.args.id);
  console.error(`registered ${basename(String(file))} hash ${docHash} as ${DOC_TYPES[type]}, ${signers.length} signer(s), tx ${tx.hash}`);
}

async function cmdSign(id, opt) {
  const c = await ctx(opt, true);
  const tx = await sendAttributed(need(c.registry), "sign", [id]);
  await tx.wait();
  console.log(`signed ${id} as ${c.wallet.address} (tx ${tx.hash})`);
  await printStatus(c, id);
}

async function cmdSignOffline(id, opt) {
  const c = await ctx(opt, false);
  const name = opt["key-env"] || "BP_PRIVATE_KEY";
  if (!process.env[name]) throw new Error(`env ${name} is empty`);
  const w = new ethers.Wallet(process.env[name]);
  const a = await need(c.registry).getAttestation(id);
  if (Number(a.status) === 0) throw new Error("unknown attestation id");
  if (opt.file && sha256File(opt.file) !== a.docHash) throw new Error("the file you are signing does not match the registered hash");
  const signature = await w.signTypedData(domainFor(c.chainId, c.address), SIGN_TYPES, { attestationId: id, docHash: a.docHash });
  const out = { attestationId: id, docHash: a.docHash, signer: w.address, signature, chainId: Number(c.chainId), registry: c.address };
  writeFileSync(opt.out || "signature.json", JSON.stringify(out, null, 2) + "\n");
  console.log(`EIP-712 signature by ${w.address} written to ${opt.out || "signature.json"}`);
}

async function cmdRelay(file, opt) {
  const c = await ctx(opt, true);
  const s = JSON.parse(readFileSync(file, "utf8"));
  if (s.chainId && Number(s.chainId) !== Number(c.chainId)) {
    throw new Error(`Signature chainId (${s.chainId}) does not match current network (${c.chainId})`);
  }
  if (s.registry && c.address && ethers.getAddress(s.registry) !== ethers.getAddress(c.address)) {
    throw new Error(`Signature registry (${s.registry}) does not match target registry (${c.address})`);
  }
  const tx = await sendAttributed(need(c.registry), "signBySig", [s.attestationId, s.signer, s.signature]);
  await tx.wait();
  console.log(`relayed signature of ${s.signer} (gas paid by ${c.wallet.address}, tx ${tx.hash})`);
  await printStatus(c, s.attestationId);
}

async function cmdReject(id, opt) {
  const c = await ctx(opt, true);
  if (!opt.reason) throw new Error("--reason <file> is required (e.g. the cross-check report)");
  const reasonHash = sha256File(opt.reason);
  const tx = await sendAttributed(need(c.registry), "reject", [id, reasonHash]);
  await tx.wait();
  console.log(`rejected ${id} by ${c.wallet.address}, reason sha256 ${reasonHash} (tx ${tx.hash})`);
}

function label(addr, parties) {
  const p = parties?.[ethers.getAddress(addr)];
  return p ? `${addr} (${p})` : addr;
}

async function printStatus(c, id, parties) {
  const reg = need(c.registry);
  const a = await reg.getAttestation(id);
  const [signers, states] = await reg.getSigners(id);
  const next = await reg.supersededBy(id);
  console.log(`  attestation ${id}`);
  console.log(`    status     ${STATUS[Number(a.status)]}${next !== ethers.ZeroHash ? `, SUPERSEDED by ${next}` : ""}`);
  console.log(`    type       ${DOC_TYPES[Number(a.docType)] || a.docType}   file sha256 ${a.docHash}`);
  console.log(`    registered ${fmtTime(a.registeredAt)} by ${label(a.registrar, parties)}`);
  if (Number(a.closedAt)) console.log(`    closed     ${fmtTime(a.closedAt)}`);
  if (a.supersedes !== ethers.ZeroHash) console.log(`    amends     ${a.supersedes}`);
  signers.forEach((s, i) => console.log(`    signer     ${label(s, parties)}  ${SIGNER_STATE[Number(states[i])]}`));
}

async function cmdVerify(target, opt) {
  const c = await ctx(opt, false);
  const docHash = toHash(target);
  let parties = null;
  if (opt.parties) {
    parties = {};
    for (const [k, v] of Object.entries(JSON.parse(readFileSync(opt.parties, "utf8")))) parties[ethers.getAddress(k)] = v;
  }
  const ids = await need(c.registry).attestationsOf(docHash);
  console.log(`document sha256 ${docHash}`);
  if (ids.length === 0) {
    console.log("  NOT FOUND: no attestation for these exact bytes. A single changed byte gives a different hash.");
    process.exitCode = 2;
    return;
  }
  for (const id of ids) await printStatus(c, id, parties);
  if (parties) {
    const known = new Set(Object.keys(parties));
    for (const id of ids) {
      const [signers, states] = await c.registry.getSigners(id);
      const a = await c.registry.getAttestation(id);
      const allKnown = signers.every((s) => known.has(ethers.getAddress(s)));
      if (Number(a.status) === 2 && allKnown) console.log(`  VALID: ${id} attested by the expected parties only.`);
      else if (!allKnown) console.log(`  WARNING: ${id} lists signers you do not know. Ignore it unless you trust them.`);
    }
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parseArgs(rest);
  switch (cmd) {
    case "hash": console.log(sha256File(pos[0])); break;
    case "deploy": await cmdDeploy(opt); break;
    case "register": await cmdRegister(pos[0], opt); break;
    case "sign": await cmdSign(pos[0], opt); break;
    case "sign-offline": await cmdSignOffline(pos[0], opt); break;
    case "relay": await cmdRelay(pos[0], opt); break;
    case "reject": await cmdReject(pos[0], opt); break;
    case "status": await printStatus(await ctx(opt), pos[0]); break;
    case "verify": await cmdVerify(pos[0], opt); break;
    default: console.log(HELP);
  }
}

main().catch((e) => {
  console.error("error:", e.shortMessage || e.message);
  process.exit(1);
});
