// End-to-end test of the paid lookup API.
// - real BuildProofRegistry on a throwaway anvil chain (needs `forge build` artifacts in out/)
// - real x402 buyer client (@x402/fetch + @x402/evm) signing EIP-3009 USDC authorizations
// - in-process facilitator that checks the EIP-712 signature exactly like a real one would,
//   and records what it would settle (no network, no funds)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { ethers } from "ethers";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { createApp, configFrom } from "../app.mjs";
import { verdict } from "../lookup.mjs";

const ROOT = new URL("../../", import.meta.url);
const NETWORK = "eip155:84532";
const PAY_TO = "0xC628715a1ed46eb555B088e3d43dc61AE0134F33";
const PORT = 18545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
// anvil default dev keys (public, test-only)
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
];

let anvil, provider, registry, client, contractor, outsider, docs, app, facilitator;

const h = (s) => ethers.sha256(ethers.toUtf8Bytes(s));

const anvilBin = () => process.env.ANVIL_BIN || "anvil";

async function waitRpc() {
  for (let i = 0; i < 100; i++) {
    try {
      await provider.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("anvil did not start");
}

class TestFacilitator {
  constructor() {
    this.settled = [];
  }
  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} };
  }
  check(payload, req) {
    const { authorization: a, signature } = payload.payload;
    const domain = { name: req.extra.name, version: req.extra.version, chainId: Number(req.network.split(":")[1]), verifyingContract: req.asset };
    const types = {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    };
    const signer = ethers.verifyTypedData(domain, types, a, signature);
    if (ethers.getAddress(signer) !== ethers.getAddress(a.from)) return "invalid_signature";
    if (ethers.getAddress(a.to) !== ethers.getAddress(req.payTo)) return "wrong_payee";
    if (BigInt(a.value) < BigInt(req.amount)) return "insufficient_amount";
    if (BigInt(a.validBefore) <= BigInt(Math.floor(Date.now() / 1000))) return "expired";
    return null;
  }
  async verify(payload, req) {
    const bad = this.check(payload, req);
    return bad ? { isValid: false, invalidReason: bad } : { isValid: true, payer: payload.payload.authorization.from };
  }
  async settle(payload, req) {
    const bad = this.check(payload, req);
    if (bad) return { success: false, errorReason: bad, transaction: "", network: req.network };
    this.settled.push({ from: payload.payload.authorization.from, to: payload.payload.authorization.to, value: payload.payload.authorization.value });
    return { success: true, transaction: "0x" + "ab".repeat(32), network: req.network, payer: payload.payload.authorization.from };
  }
}

function buyer(app, wallet) {
  const signer = {
    address: wallet.address,
    signTypedData: ({ domain, types, message }) => {
      const t = { ...types };
      delete t.EIP712Domain;
      return wallet.signTypedData(domain, t, message);
    },
  };
  const c = new x402Client().register(NETWORK, new ExactEvmScheme(signer));
  const f = (input, init) => app.fetch(input instanceof Request ? input : new Request(input, init));
  return wrapFetchWithPayment(f, c);
}

before(async () => {
  const art = new URL("out/BuildProofRegistry.sol/BuildProofRegistry.json", ROOT);
  assert.ok(existsSync(art), "run `forge build` first");
  anvil = spawn(anvilBin(), ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  provider = new ethers.JsonRpcProvider(RPC, 31337, { staticNetwork: true, polling: true });
  await waitRpc();
  [client, contractor, outsider] = KEYS.map((k) => new ethers.NonceManager(new ethers.Wallet(k, provider)));
  const j = JSON.parse(readFileSync(art, "utf8"));
  const f = new ethers.ContractFactory(j.abi, j.bytecode.object, client);
  registry = await f.deploy();
  await registry.waitForDeployment();
  const R = (who) => registry.connect(who);
  const [ca, ka] = [await client.getAddress(), await contractor.getAddress()];

  const idOf = async (tx) => {
    const rc = await (await tx).wait();
    return rc.logs.map((l) => registry.interface.parseLog(l)).find((e) => e?.name === "Registered").args.id;
  };

  docs = { contract: h("contract"), sa1: h("sa1"), act1: h("act1"), act2: h("act2"), pending: h("pending"), unknown: h("unknown") };
  const Z = ethers.ZeroHash;
  const P = ethers.encodeBytes32String("PLOT-7");
  const cId = await idOf(R(client).register(docs.contract, 1, P, Z, [ca, ka]));
  await (await R(client).sign(cId)).wait();
  await (await R(contractor).sign(cId)).wait();
  const saId = await idOf(R(client).register(docs.sa1, 2, P, cId, [ca, ka]));
  await (await R(client).sign(saId)).wait();
  await (await R(contractor).sign(saId)).wait();
  const a1 = await idOf(R(client).register(docs.act1, 3, P, Z, [ca, ka]));
  await (await R(client).sign(a1)).wait();
  await (await R(contractor).sign(a1)).wait();
  const a2 = await idOf(R(client).register(docs.act2, 3, P, Z, [ca, ka]));
  await (await R(contractor).sign(a2)).wait();
  await (await R(client).reject(a2, h("crosscheck report"))).wait();
  await idOf(R(client).register(docs.pending, 3, P, Z, [ca, ka]));
  // a stranger registers the same act with fake signers
  await idOf(R(outsider).register(docs.act1, 3, P, Z, [await outsider.getAddress()]));

  facilitator = new TestFacilitator();
  const cfg = configFrom({ BP_RPC: RPC, BP_REGISTRY: await registry.getAddress(), X402_NETWORK: NETWORK, PAY_TO });
  app = createApp(cfg, { facilitator, provider });
});

after(() => anvil?.kill());

test("unpaid request gets 402 with a price list paying our address in USDC on Base Sepolia", async () => {
  const r = await app.fetch(new Request(`http://x/v1/attestation/${docs.act1}`));
  assert.equal(r.status, 402);
  const pr = JSON.parse(Buffer.from(r.headers.get("payment-required"), "base64").toString());
  assert.equal(pr.x402Version, 2);
  const acc = pr.accepts[0];
  assert.equal(acc.scheme, "exact");
  assert.equal(acc.network, NETWORK);
  assert.equal(ethers.getAddress(acc.payTo), PAY_TO);
  assert.equal(acc.amount, "10000"); // $0.01 in 6-decimal USDC
  assert.equal(ethers.getAddress(acc.asset), "0x036CbD53842c5426634e7929541eC2318f3dCF7e"); // USDC on Base Sepolia (Circle docs)
  assert.equal(facilitator.settled.length, 0);
});

test("malformed hash or signer list is rejected before any payment (400, not 402)", async () => {
  assert.equal((await app.fetch(new Request("http://x/v1/attestation/0x1234"))).status, 400);
  assert.equal((await app.fetch(new Request(`http://x/v1/attestation/${docs.act1}?signers=nope`))).status, 400);
});

test("free endpoints: info and OpenAPI", async () => {
  const info = await (await app.fetch(new Request("http://x/"))).json();
  assert.equal(ethers.getAddress(info.payTo), PAY_TO);
  const spec = await (await app.fetch(new Request("http://x/openapi.json"))).json();
  assert.ok(spec.paths["/v1/attestation/{docHash}"].get);
});

test("paid request: attested act, signers and dates, payment settled to our address", async () => {
  const pay = buyer(app, ethers.Wallet.createRandom());
  const before = facilitator.settled.length;
  const r = await pay(`http://x/v1/attestation/${docs.act1}?signers=${await client.getAddress()},${await contractor.getAddress()}`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.verdict, "ATTESTED");
  assert.equal(body.attestations.length, 2); // real one + stranger's fake one
  const real = body.attestations.find((a) => a.matchesExpectedSigners);
  assert.equal(real.status, "ATTESTED");
  assert.equal(real.docType, "acceptance-act");
  assert.deepEqual(real.signers.map((s) => s.state), ["signed", "signed"]);
  assert.ok(real.closedAt && real.registeredAt);
  const fake = body.attestations.find((a) => !a.matchesExpectedSigners);
  assert.equal(fake.status, "PENDING");
  const settle = decodePaymentResponseHeader(r.headers.get("payment-response"));
  assert.equal(settle.success, true);
  assert.equal(facilitator.settled.length, before + 1);
  assert.equal(ethers.getAddress(facilitator.settled.at(-1).to), PAY_TO);
  assert.equal(facilitator.settled.at(-1).value, "10000");
});

test("paid request: contract superseded by its supplementary agreement", async () => {
  const body = await (await buyer(app, ethers.Wallet.createRandom())(`http://x/v1/attestation/${docs.contract}`)).json();
  assert.equal(body.verdict, "SUPERSEDED");
  const a = body.attestations[0];
  assert.equal(a.status, "ATTESTED");
  assert.equal(a.superseded, true);
  assert.equal(a.supersededBy.docHash, docs.sa1);
  assert.equal(a.supersededBy.docType, "supplementary-agreement");
});

test("paid request: rejected act, pending act, unknown hash", async () => {
  const pay = buyer(app, ethers.Wallet.createRandom());
  const v = async (d) => (await (await pay(`http://x/v1/attestation/${d}`)).json()).verdict;
  assert.equal(await v(docs.act2), "REJECTED");
  assert.equal(await v(docs.pending), "PENDING");
  assert.equal(await v(docs.unknown), "NOT_FOUND");
});

test("only the stranger's record matches unknown signers: NO_MATCHING_SIGNERS", async () => {
  const pay = buyer(app, ethers.Wallet.createRandom());
  const body = await (await pay(`http://x/v1/attestation/${docs.act1}?signers=${ethers.Wallet.createRandom().address}`)).json();
  assert.equal(body.verdict, "NO_MATCHING_SIGNERS");
});

test("payment to a different address is refused and nothing is served", async () => {
  // forged client: signs an authorization to its own address instead of PAY_TO
  const w = ethers.Wallet.createRandom();
  const signer = {
    address: w.address,
    signTypedData: ({ domain, types, message }) => {
      const t = { ...types };
      delete t.EIP712Domain;
      return w.signTypedData(domain, t, { ...message, to: w.address });
    },
  };
  const c = new x402Client().register(NETWORK, new ExactEvmScheme(signer));
  const pay = wrapFetchWithPayment((i, init) => app.fetch(i instanceof Request ? i : new Request(i, init)), c);
  const before = facilitator.settled.length;
  const r = await pay(`http://x/v1/attestation/${docs.act1}`);
  assert.equal(r.status, 402);
  assert.equal(facilitator.settled.length, before);
});

test("verdict(): preference order", () => {
  assert.equal(verdict([], false), "NOT_FOUND");
  assert.equal(verdict([{ status: "REJECTED" }, { status: "PENDING" }], false), "PENDING");
  assert.equal(verdict([{ status: "ATTESTED", superseded: false }, { status: "REJECTED" }], false), "ATTESTED");
  assert.equal(verdict([{ status: "ATTESTED", superseded: true }], false), "SUPERSEDED");
});
