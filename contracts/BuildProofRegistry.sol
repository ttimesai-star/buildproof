// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title BuildProofRegistry
/// @notice Notary-style registry for construction documents (contracts, supplementary
///         agreements, acceptance acts, as-built documentation, invoices).
///         Only the SHA-256 hash of the final file goes on-chain. Content never does.
/// @dev Anyone may register a hash. Trust comes from WHO signed it: an attestation
///      becomes ATTESTED only when every required signer has signed, either directly
///      (msg.sender) or by an EIP-712 signature submitted by a relayer. A verifier always
///      checks the signer addresses against the parties they expect.
contract BuildProofRegistry {
    enum Status {
        None,
        Pending,
        Attested,
        Rejected
    }

    /// 0 Other, 1 Contract, 2 SupplementaryAgreement, 3 AcceptanceAct,
    /// 4 AsBuiltDocumentation, 5 Invoice. Values above 5 are allowed for future use.
    struct Attestation {
        bytes32 docHash; // SHA-256 of the exact file bytes
        bytes32 projectRef; // opaque project reference (e.g. keccak of an internal code)
        bytes32 supersedes; // attestation id this document amends/replaces, or 0
        address registrar;
        uint64 registeredAt;
        uint64 closedAt; // time it became Attested or Rejected
        uint8 docType;
        Status status;
        uint16 signerCount;
        uint16 signedCount;
    }

    uint256 public constant MAX_SIGNERS = 16;

    bytes32 public constant SIGN_TYPEHASH = keccak256("Sign(bytes32 attestationId,bytes32 docHash)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("BuildProof");
    bytes32 private constant VERSION_HASH = keccak256("1");
    // secp256k1n / 2, upper bound for a non-malleable `s`
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    mapping(bytes32 => Attestation) private _att;
    mapping(bytes32 => address[]) private _signers;
    /// 0 = not a signer, 1 = required (not yet signed), 2 = signed, 3 = rejected
    mapping(bytes32 => mapping(address => uint8)) private _state;
    mapping(bytes32 => bytes32[]) private _byHash;
    mapping(bytes32 => bytes32) public supersededBy;

    event Registered(
        bytes32 indexed id,
        bytes32 indexed docHash,
        address indexed registrar,
        uint8 docType,
        bytes32 projectRef,
        bytes32 supersedes,
        address[] signers
    );
    event Signed(bytes32 indexed id, address indexed signer, bool viaSignature);
    event Attested(bytes32 indexed id, bytes32 indexed docHash);
    event Rejected(bytes32 indexed id, address indexed signer, bytes32 reasonHash);
    event Superseded(bytes32 indexed oldId, bytes32 indexed newId);

    error ZeroHash();
    error BadSignerList();
    error AlreadyRegistered(bytes32 id);
    error UnknownAttestation(bytes32 id);
    error NotPending(bytes32 id);
    error NotARequiredSigner(address who);
    error AlreadySigned(address who);
    error BadSupersedes(bytes32 id);
    error BadSignature();

    // ---------------------------------------------------------------- write

    /// @notice Register a document hash and the parties that must sign it.
    /// @return id attestation id = keccak256(docHash, docType, projectRef, supersedes, signers, registrar)
    function register(
        bytes32 docHash,
        uint8 docType,
        bytes32 projectRef,
        bytes32 supersedes,
        address[] calldata signers
    ) external returns (bytes32 id) {
        if (docHash == bytes32(0)) revert ZeroHash();
        uint256 n = signers.length;
        if (n == 0 || n > MAX_SIGNERS) revert BadSignerList();

        id = keccak256(abi.encode(docHash, docType, projectRef, supersedes, signers, msg.sender));
        if (_att[id].status != Status.None) revert AlreadyRegistered(id);

        if (supersedes != bytes32(0)) {
            Attestation storage old = _att[supersedes];
            // Only an attested document can be amended, only once, and only by one of its signers.
            if (old.status != Status.Attested || supersededBy[supersedes] != bytes32(0)) {
                revert BadSupersedes(supersedes);
            }
            if (_state[supersedes][msg.sender] != 2) revert BadSupersedes(supersedes);
        }

        for (uint256 i = 0; i < n; i++) {
            address s = signers[i];
            if (s == address(0) || _state[id][s] != 0) revert BadSignerList();
            _state[id][s] = 1;
            _signers[id].push(s);
        }

        _att[id] = Attestation({
            docHash: docHash,
            projectRef: projectRef,
            supersedes: supersedes,
            registrar: msg.sender,
            registeredAt: uint64(block.timestamp),
            closedAt: 0,
            docType: docType,
            status: Status.Pending,
            signerCount: uint16(n),
            signedCount: 0
        });
        _byHash[docHash].push(id);

        emit Registered(id, docHash, msg.sender, docType, projectRef, supersedes, signers);
    }

    /// @notice Sign as msg.sender.
    function sign(bytes32 id) external {
        _sign(id, msg.sender, false);
    }

    /// @notice Submit a party's EIP-712 signature (party pays no gas; anyone can relay).
    function signBySig(bytes32 id, address signer, bytes calldata signature) external {
        Attestation storage a = _att[id];
        if (a.status == Status.None) revert UnknownAttestation(id);
        bytes32 digest = signDigest(id);
        if (_recover(digest, signature) != signer) revert BadSignature();
        _sign(id, signer, true);
    }

    /// @notice A required signer refuses to sign (e.g. the AI check or a site inspection found
    ///         a discrepancy). The reason text stays off-chain; only its hash is recorded.
    function reject(bytes32 id, bytes32 reasonHash) external {
        Attestation storage a = _att[id];
        if (a.status == Status.None) revert UnknownAttestation(id);
        if (a.status != Status.Pending) revert NotPending(id);
        uint8 st = _state[id][msg.sender];
        if (st == 0) revert NotARequiredSigner(msg.sender);
        if (st != 1) revert AlreadySigned(msg.sender);
        _state[id][msg.sender] = 3;
        a.status = Status.Rejected;
        a.closedAt = uint64(block.timestamp);
        emit Rejected(id, msg.sender, reasonHash);
    }

    // ---------------------------------------------------------------- read

    function getAttestation(bytes32 id) external view returns (Attestation memory) {
        return _att[id];
    }

    function getSigners(bytes32 id) external view returns (address[] memory signers, uint8[] memory states) {
        signers = _signers[id];
        states = new uint8[](signers.length);
        for (uint256 i = 0; i < signers.length; i++) {
            states[i] = _state[id][signers[i]];
        }
    }

    /// @notice All attestation ids ever registered for a file hash (there can be several,
    ///         e.g. a griefing registration with fake signers next to the real one).
    function attestationsOf(bytes32 docHash) external view returns (bytes32[] memory) {
        return _byHash[docHash];
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function signDigest(bytes32 id) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(SIGN_TYPEHASH, id, _att[id].docHash));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    // ---------------------------------------------------------------- internal

    function _sign(bytes32 id, address signer, bool viaSig) internal {
        Attestation storage a = _att[id];
        if (a.status == Status.None) revert UnknownAttestation(id);
        if (a.status != Status.Pending) revert NotPending(id);
        uint8 st = _state[id][signer];
        if (st == 0) revert NotARequiredSigner(signer);
        if (st != 1) revert AlreadySigned(signer);

        _state[id][signer] = 2;
        a.signedCount += 1;
        emit Signed(id, signer, viaSig);

        if (a.signedCount == a.signerCount) {
            a.status = Status.Attested;
            a.closedAt = uint64(block.timestamp);
            emit Attested(id, a.docHash);
            bytes32 old = a.supersedes;
            if (old != bytes32(0)) {
                if (supersededBy[old] != bytes32(0)) revert BadSupersedes(old);
                supersededBy[old] = id;
                emit Superseded(old, id);
            }
        }
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (uint256(s) > HALF_N) revert BadSignature();
        if (v != 27 && v != 28) revert BadSignature();
        address who = ecrecover(digest, v, r, s);
        if (who == address(0)) revert BadSignature();
        return who;
    }
}
