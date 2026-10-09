// ERC-8021 builder-code suffix: encoding against the Base docs, the dashboard and the
// reference implementation (ox), and an end-to-end check on anvil that the registry
// accepts register / sign / signBySig / reject calls that carry the suffix.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { ethers } from "ethers";
import { Attribution } from "ox/erc8021";
import { BUILDER_CODE, toDataSuffix, readDataSuffix, activeCodes, sendAttributed } from "../attribution.mjs";
import { ABI, SIGN_TYPES, STATUS, domainFor } from "../abi.mjs";

// Example from docs.base.org/specifications/builder-codes/for-app-developers
const DOCS_EXAMPLE = "0x62635f62376b33703964610b0080218021802180218021802180218021";
// Copied from dashboard.base.org -> Project Settings -> Builder Code -> Encoded String
const DASHBOARD_ENCODED = "0x62635f613937746d7468750b0080218021802180218021802180218021";

test("matches the example in the Base docs", () => {
  assert.equal(toDataSuffix(["bc_b7k3p9da"]), DOCS_EXAMPLE);
});

test("BuildProof code matches the dashboard's encoded string", () => {
  assert.equal(toDataSuffix([BUILDER_CODE]), DASHBOARD_ENCODED);
});

test("matches ox (reference implementation used by viem/wagmi)", () => {
  for (const codes of [[BUILDER_CODE], ["bc_b7k3p9da"], [BUILDER_CODE, "wallet_x"]]) {
    assert.equal(toDataSuffix(codes), Attribution.toDataSuffix({ codes }));
  }
});

test("round trip and rejection of bad codes", () => {
  assert.deepEqual(readDataSuffix("0xabcdef" + DASHBOARD_ENCODED.slice(2)).codes, [BUILDER_CODE]);
  assert.deepEqual(readDataSuffix("0x" + "11".repeat(36) + toDataSuffix(["a", "b"]).slice(2)).codes, ["a", "b"]);
  assert.equal(readDataSuffix("0xabcdef"), null);
  assert.throws(() => toDataSuffix(["has space"]));
  assert.throws(() => toDataSuffix(["a,b"]));
  assert.equal(toDataSuffix([]), "0x");
});

test("env override", () => {
  assert.deepEqual(activeCodes({}), [BUILDER_CODE]);
  assert.deepEqual(activeCodes({ BP_BUILDER_CODE: "none" }), []);
  assert.deepEqual(activeCodes({ BP_BUILDER_CODE: "x1, y2" }), ["x1", "y2"]);
});

// --- end to end on anvil ---------------------------------------------------
const PORT = 19545 + Math.floor(Math.random() * 1000);
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
];
let anvil, provider, registry, a, b;

async function waitRpc() {
  for (let i = 0; i < 100; i++) {
    try { await provider.getBlockNumber(); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error("anvil did not start");
}

before(async () => {
  const art = new URL("../../out/BuildProofRegistry.sol/BuildProofRegistry.json", import.meta.url);
  assert.ok(existsSync(art), "run `forge build` first");
  anvil = spawn(process.env.ANVIL_BIN || "anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, 31337, { staticNetwork: true, polling: true });
  await waitRpc();
  [a, b] = KEYS.map((k) => new ethers.NonceManager(new ethers.Wallet(k, provider)));
  const j = JSON.parse(readFileSync(art, "utf8"));
  const deployed = await new ethers.ContractFactory(j.abi, j.bytecode.object, a).deploy();
  await deployed.waitForDeployment();
  registry = new ethers.Contract(await deployed.getAddress(), ABI, a);
});

after(() => anvil?.kill());

test("registry accepts attributed register, sign, signBySig and reject", async () => {
  const [aa, ba] = [await a.getAddress(), await b.getAddress()];
  const sfx = toDataSuffix([BUILDER_CODE]).slice(2);
  const docHash = ethers.sha256(ethers.toUtf8Bytes("act-1"));

  const tx1 = await sendAttributed(registry, "register", [docHash, 3, ethers.ZeroHash, ethers.ZeroHash, [aa, ba]], [BUILDER_CODE]);
  const rc1 = await tx1.wait();
  assert.equal(rc1.status, 1);
  assert.ok((await provider.getTransaction(tx1.hash)).data.endsWith(sfx), "suffix is on-chain");
  const id = rc1.logs.map((l) => registry.interface.parseLog(l)).find((e) => e?.name === "Registered").args.id;

  assert.equal((await (await sendAttributed(registry, "sign", [id], [BUILDER_CODE])).wait()).status, 1);

  const chainId = (await provider.getNetwork()).chainId;
  const sig = await new ethers.Wallet(KEYS[1]).signTypedData(domainFor(chainId, await registry.getAddress()), SIGN_TYPES, { attestationId: id, docHash });
  const tx3 = await sendAttributed(registry, "signBySig", [id, ba, sig], [BUILDER_CODE]);
  assert.equal((await tx3.wait()).status, 1);
  assert.deepEqual(readDataSuffix((await provider.getTransaction(tx3.hash)).data).codes, [BUILDER_CODE]);
  assert.equal(STATUS[Number((await registry.getAttestation(id)).status)], "ATTESTED");

  const doc2 = ethers.sha256(ethers.toUtf8Bytes("act-2"));
  const rc4 = await (await sendAttributed(registry, "register", [doc2, 3, ethers.ZeroHash, ethers.ZeroHash, [aa]], [BUILDER_CODE])).wait();
  const id2 = rc4.logs.map((l) => registry.interface.parseLog(l)).find((e) => e?.name === "Registered").args.id;
  assert.equal((await (await sendAttributed(registry, "reject", [id2, ethers.sha256("0x01")], [BUILDER_CODE])).wait()).status, 1);
  assert.equal(STATUS[Number((await registry.getAttestation(id2)).status)], "REJECTED");
});
