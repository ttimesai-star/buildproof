// Human-readable ABI of BuildProofRegistry (shared by the CLI; docs/app.js keeps a copy).
export const ABI = [
  "function register(bytes32 docHash, uint8 docType, bytes32 projectRef, bytes32 supersedes, address[] signers) returns (bytes32)",
  "function sign(bytes32 id)",
  "function signBySig(bytes32 id, address signer, bytes signature)",
  "function reject(bytes32 id, bytes32 reasonHash)",
  "function getAttestation(bytes32 id) view returns (tuple(bytes32 docHash, bytes32 projectRef, bytes32 supersedes, address registrar, uint64 registeredAt, uint64 closedAt, uint8 docType, uint8 status, uint16 signerCount, uint16 signedCount))",
  "function getSigners(bytes32 id) view returns (address[] signers, uint8[] states)",
  "function attestationsOf(bytes32 docHash) view returns (bytes32[])",
  "function supersededBy(bytes32 id) view returns (bytes32)",
  "function signDigest(bytes32 id) view returns (bytes32)",
  "event Registered(bytes32 indexed id, bytes32 indexed docHash, address indexed registrar, uint8 docType, bytes32 projectRef, bytes32 supersedes, address[] signers)",
  "event Signed(bytes32 indexed id, address indexed signer, bool viaSignature)",
  "event Attested(bytes32 indexed id, bytes32 indexed docHash)",
  "event Rejected(bytes32 indexed id, address indexed signer, bytes32 reasonHash)",
  "event Superseded(bytes32 indexed oldId, bytes32 indexed newId)",
];

export const DOC_TYPES = ["other", "contract", "supplementary-agreement", "acceptance-act", "as-built", "invoice", "nda", "ai-output"];
export const STATUS = ["NONE", "PENDING", "ATTESTED", "REJECTED"];
export const SIGNER_STATE = ["-", "awaiting", "signed", "rejected"];

export const SIGN_TYPES = { Sign: [{ name: "attestationId", type: "bytes32" }, { name: "docHash", type: "bytes32" }] };
export const domainFor = (chainId, verifyingContract) => ({ name: "BuildProof", version: "1", chainId, verifyingContract });
