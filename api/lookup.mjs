// Read-only lookup of a document hash in BuildProofRegistry.
// Shared by the paid HTTP API (Cloudflare Worker / Node). No keys, no writes.
import { ethers } from "ethers";
import { ABI, DOC_TYPES, STATUS, SIGNER_STATE } from "../cli/abi.mjs";

export const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ZERO = ethers.ZeroHash;

const iso = (t) => (Number(t) > 0 ? new Date(Number(t) * 1000).toISOString() : null);

/** Parse "0xA,0xB" into checksummed addresses; throws on a bad address. */
export function parseSigners(list) {
  if (!list) return null;
  const out = String(list)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => ethers.getAddress(s));
  return out.length ? out : null;
}

/**
 * Look a document hash up in the registry.
 * @param {ethers.Provider} provider
 * @param {string} registryAddress
 * @param {string} docHash 0x-prefixed SHA-256 of the file bytes
 * @param {{expectedSigners?: string[]|null}} [opt]
 */
export async function lookupDocument(provider, registryAddress, docHash, opt = {}) {
  if (!HASH_RE.test(docHash)) throw new Error("docHash must be 0x + 64 hex chars");
  const registry = new ethers.Contract(registryAddress, ABI, provider);
  const [{ chainId }, ids] = await Promise.all([provider.getNetwork(), registry.attestationsOf(docHash)]);
  const expected = opt.expectedSigners ? new Set(opt.expectedSigners.map((a) => ethers.getAddress(a))) : null;

  const attestations = [];
  for (const id of ids) {
    const [a, [signers, states], next] = await Promise.all([
      registry.getAttestation(id),
      registry.getSigners(id),
      registry.supersededBy(id),
    ]);
    let supersededBy = null;
    if (next !== ZERO) {
      const n = await registry.getAttestation(next);
      supersededBy = { id: next, docHash: n.docHash, docType: DOC_TYPES[Number(n.docType)] ?? String(n.docType), attestedAt: iso(n.closedAt) };
    }
    const status = STATUS[Number(a.status)] ?? String(a.status);
    const signerList = signers.map((s, i) => ({ address: ethers.getAddress(s), state: SIGNER_STATE[Number(states[i])] ?? String(states[i]) }));
    const rec = {
      id,
      docType: DOC_TYPES[Number(a.docType)] ?? String(a.docType),
      status,
      superseded: supersededBy !== null,
      supersededBy,
      supersedes: a.supersedes === ZERO ? null : a.supersedes,
      projectRef: a.projectRef,
      registrar: ethers.getAddress(a.registrar),
      registeredAt: iso(a.registeredAt),
      closedAt: iso(a.closedAt),
      signedCount: Number(a.signedCount),
      signerCount: Number(a.signerCount),
      signers: signerList,
    };
    if (expected) {
      const listed = new Set(signerList.map((s) => s.address));
      rec.matchesExpectedSigners = listed.size === expected.size && [...expected].every((a) => listed.has(a));
    }
    attestations.push(rec);
  }

  return {
    docHash: docHash.toLowerCase(),
    chainId: Number(chainId),
    registry: ethers.getAddress(registryAddress),
    verdict: verdict(attestations, expected !== null),
    attestations,
    note: "Records anyone can create; trust a record only if its signers are the parties you expect (pass ?signers=0xA,0xB).",
  };
}

/**
 * One-word answer for an agent. With expected signers, only matching records count.
 * Order of preference: SUPERSEDED/ATTESTED > PENDING > REJECTED > NOT_FOUND.
 */
export function verdict(attestations, filterByExpected) {
  const pool = filterByExpected ? attestations.filter((a) => a.matchesExpectedSigners) : attestations;
  if (attestations.length === 0) return "NOT_FOUND";
  if (pool.length === 0) return "NO_MATCHING_SIGNERS";
  const attested = pool.filter((a) => a.status === "ATTESTED");
  if (attested.length) return attested.every((a) => a.superseded) ? "SUPERSEDED" : "ATTESTED";
  if (pool.some((a) => a.status === "PENDING")) return "PENDING";
  return "REJECTED";
}
