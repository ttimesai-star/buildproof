import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { ABI, DOC_TYPES, STATUS, SIGN_TYPES, domainFor } from "../abi.mjs";
import { buildManifest } from "../manifest.mjs";
import { sha256File } from "../buildproof.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 19600 + Math.floor(Math.random() * 1000);
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
];

let anvil, provider, registry, a, b, relayer;

async function waitRpc() {
  for (let i = 0; i < 100; i++) {
    try { await provider.getBlockNumber(); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error("anvil did not start");
}

before(async () => {
  const art = join(ROOT, "out", "BuildProofRegistry.sol", "BuildProofRegistry.json");
  assert.ok(existsSync(art), "run `forge build` first");
  anvil = spawn(process.env.ANVIL_BIN || "anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, 31337, { staticNetwork: true, polling: true });
  await waitRpc();
  [a, b, relayer] = KEYS.map((k) => new ethers.NonceManager(new ethers.Wallet(k, provider)));
  const j = JSON.parse(readFileSync(art, "utf8"));
  const deployed = await new ethers.ContractFactory(j.abi, j.bytecode.object, a).deploy();
  await deployed.waitForDeployment();
  registry = new ethers.Contract(await deployed.getAddress(), ABI, a);
});

after(() => anvil?.kill());

test("(a) register nda_mutual.pdf as type nda with two signers (direct + signBySig) -> ATTESTED", async () => {
  const ndaPath = join(ROOT, "examples", "legal", "nda_mutual.pdf");
  const docHash = sha256File(ndaPath);
  const [pa, pb] = [await a.getAddress(), await b.getAddress()];
  const typeIndex = DOC_TYPES.indexOf("nda");
  assert.equal(typeIndex, 6);

  const tx1 = await registry.connect(a).register(docHash, typeIndex, ethers.ZeroHash, ethers.ZeroHash, [pa, pb]);
  const rc1 = await tx1.wait();
  const id = rc1.logs.map((l) => registry.interface.parseLog(l)).find((e) => e?.name === "Registered").args.id;

  // Party A signs directly
  await (await registry.connect(a).sign(id)).wait();

  // Party B signs via EIP-712 signBySig relayed by relayer
  const chainId = (await provider.getNetwork()).chainId;
  const sig = await new ethers.Wallet(KEYS[1]).signTypedData(
    domainFor(chainId, await registry.getAddress()),
    SIGN_TYPES,
    { attestationId: id, docHash }
  );
  await (await registry.connect(relayer).signBySig(id, pb, sig)).wait();

  const att = await registry.getAttestation(id);
  assert.equal(STATUS[Number(att.status)], "ATTESTED");
});

test("(b) modified PDF with one byte changed -> no attestation found", async () => {
  const ndaPath = join(ROOT, "examples", "legal", "nda_mutual.pdf");
  const originalBytes = readFileSync(ndaPath);
  const modifiedBytes = Buffer.from(originalBytes);
  modifiedBytes[modifiedBytes.length - 1] ^= 0xff;
  const tamperedHash = ethers.sha256(modifiedBytes);

  const ids = await registry.attestationsOf(tamperedHash);
  assert.equal(ids.length, 0);
});

test("(c) buildManifest is deterministic and matches committed ai_review_manifest.json byte-for-byte", () => {
  const promptFile = join(ROOT, "examples", "legal", "ai_review_prompt.txt");
  const inputFile = join(ROOT, "examples", "legal", "nda_mutual.pdf");
  const outputFile = join(ROOT, "examples", "legal", "ai_review_output.md");
  const committedFile = join(ROOT, "examples", "legal", "ai_review_manifest.json");

  const m1 = buildManifest({
    model: "gpt-4o",
    promptFile,
    inputFiles: [inputFile],
    outputFile,
    created: "2026-10-09",
  });

  const m2 = buildManifest({
    model: "gpt-4o",
    promptFile,
    inputFiles: inputFile,
    outputFile,
    created: "2026-10-09",
  });

  assert.equal(m1, m2);
  assert.equal(ethers.sha256(ethers.toUtf8Bytes(m1)), ethers.sha256(ethers.toUtf8Bytes(m2)));

  const mChangedOutput = buildManifest({
    model: "gpt-4o",
    promptFile,
    inputFiles: inputFile,
    outputFile: promptFile,
    created: "2026-10-09",
  });

  assert.notEqual(m1, mChangedOutput);
  assert.notEqual(ethers.sha256(ethers.toUtf8Bytes(m1)), ethers.sha256(ethers.toUtf8Bytes(mChangedOutput)));

  const committedContent = readFileSync(committedFile, "utf8");
  assert.equal(m1, committedContent);
});

test("(d) register manifest hash as type ai-output: operator signs -> PENDING, reviewer signs -> ATTESTED", async () => {
  const manifestPath = join(ROOT, "examples", "legal", "ai_review_manifest.json");
  const manifestHash = sha256File(manifestPath);
  const [operator, reviewer] = [await a.getAddress(), await b.getAddress()];
  const typeIndex = DOC_TYPES.indexOf("ai-output");
  assert.equal(typeIndex, 7);

  const tx = await registry.connect(a).register(manifestHash, typeIndex, ethers.ZeroHash, ethers.ZeroHash, [operator, reviewer]);
  const rc = await tx.wait();
  const id = rc.logs.map((l) => registry.interface.parseLog(l)).find((e) => e?.name === "Registered").args.id;

  // AI operator signs
  await (await registry.connect(a).sign(id)).wait();
  let att = await registry.getAttestation(id);
  assert.equal(STATUS[Number(att.status)], "PENDING");

  // Human reviewer signs
  await (await registry.connect(b).sign(id)).wait();
  att = await registry.getAttestation(id);
  assert.equal(STATUS[Number(att.status)], "ATTESTED");
});

test("(e) reviewer rejects with a reason hash instead -> REJECTED", async () => {
  const manifestPath = join(ROOT, "examples", "legal", "ai_review_manifest.json");
  const manifestHash = sha256File(manifestPath);
  const [operator, reviewer] = [await a.getAddress(), await b.getAddress()];
  const typeIndex = DOC_TYPES.indexOf("ai-output");
  const projRef = ethers.id("review-reject");

  const tx = await registry.connect(a).register(manifestHash, typeIndex, projRef, ethers.ZeroHash, [operator, reviewer]);
  const rc = await tx.wait();
  const id = rc.logs.map((l) => registry.interface.parseLog(l)).find((e) => e?.name === "Registered").args.id;

  // AI operator signs
  await (await registry.connect(a).sign(id)).wait();

  // Reviewer rejects with reason hash
  const reasonHash = ethers.sha256(ethers.toUtf8Bytes("AI risk output contains inaccuracies in clause 3"));
  await (await registry.connect(b).reject(id, reasonHash)).wait();

  const att = await registry.getAttestation(id);
  assert.equal(STATUS[Number(att.status)], "REJECTED");
});
