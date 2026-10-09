// ERC-8021 transaction attribution (Base Builder Codes).
// The suffix is appended to the end of the calldata. The registry ignores it
// (Solidity ABI decoding does not read past the arguments); offchain indexers
// read it backwards: 16-byte marker, 1-byte schema id, 1-byte length, codes.
// Spec: https://eip.tools/eip/8021 , https://docs.base.org/specifications/builder-codes/overview

// BuildProof's code, registered on dashboard.base.org (Project Settings -> Builder Code).
export const BUILDER_CODE = "bc_a97tmthu";

export const ERC8021_MARKER = "80218021802180218021802180218021";
const SCHEMA_CANONICAL = "00";

// Schema 0: codes joined by "," as ASCII, then their byte length, schema id, marker.
export function toDataSuffix(codes) {
  const list = (Array.isArray(codes) ? codes : [codes]).map((c) => String(c).trim()).filter(Boolean);
  if (!list.length) return "0x";
  for (const c of list) {
    if (!/^[\x21-\x7e]+$/.test(c) || c.includes(",")) throw new Error(`invalid builder code: ${JSON.stringify(c)}`);
  }
  const ascii = Buffer.from(list.join(","), "ascii");
  if (ascii.length > 255) throw new Error("builder codes too long for one suffix");
  return "0x" + ascii.toString("hex") + ascii.length.toString(16).padStart(2, "0") + SCHEMA_CANONICAL + ERC8021_MARKER;
}

// Reads the codes back from calldata, or null when there is no ERC-8021 suffix.
export function readDataSuffix(data) {
  const h = String(data).replace(/^0x/, "").toLowerCase();
  if (!h.endsWith(ERC8021_MARKER)) return null;
  const body = h.slice(0, -ERC8021_MARKER.length);
  const schema = body.slice(-2);
  if (schema !== SCHEMA_CANONICAL) return { schema: parseInt(schema, 16), codes: null };
  const len = parseInt(body.slice(-4, -2), 16);
  const codesHex = body.slice(-4 - len * 2, -4);
  return { schema: 0, codes: Buffer.from(codesHex, "hex").toString("ascii").split(",") };
}

// Which codes to use: env BP_BUILDER_CODE overrides ("" or "none" disables).
export function activeCodes(env = process.env) {
  const v = env.BP_BUILDER_CODE;
  if (v === undefined) return [BUILDER_CODE];
  if (v === "" || v.toLowerCase() === "none") return [];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export function appendSuffix(data, suffix) {
  if (!suffix || suffix === "0x") return data;
  return data + suffix.replace(/^0x/, "");
}

// Send `contract.method(...args)` with the attribution suffix on the calldata.
export async function sendAttributed(contract, method, args, codes = activeCodes()) {
  const tx = await contract[method].populateTransaction(...args);
  tx.data = appendSuffix(tx.data, toDataSuffix(codes));
  return contract.runner.sendTransaction(tx);
}
