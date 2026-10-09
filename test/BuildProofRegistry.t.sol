// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BuildProofRegistry} from "../contracts/BuildProofRegistry.sol";

contract BuildProofRegistryTest is Test {
    BuildProofRegistry reg;

    uint256 clientKey = 0xA11CE;
    uint256 contractorKey = 0xB0B;
    uint256 supervisorKey = 0xC0FFEE;
    address client;
    address contractor;
    address supervisor;
    address stranger = address(0xBAD);

    // keccak256 stands in for the SHA-256 file hash (sha256 is a precompile call and would
    // be consumed by vm.expectRevert).
    bytes32 constant DOC = keccak256("acceptance act no. 1, final PDF bytes");
    bytes32 constant PROJECT = keccak256("PROJECT-A");

    event Attested(bytes32 indexed id, bytes32 indexed docHash);
    event Superseded(bytes32 indexed oldId, bytes32 indexed newId);
    event Rejected(bytes32 indexed id, address indexed signer, bytes32 reasonHash);

    function setUp() public {
        reg = new BuildProofRegistry();
        client = vm.addr(clientKey);
        contractor = vm.addr(contractorKey);
        supervisor = vm.addr(supervisorKey);
    }

    function _parties() internal view returns (address[] memory s) {
        s = new address[](2);
        s[0] = client;
        s[1] = contractor;
    }

    function _register(bytes32 docHash, uint8 docType, bytes32 supersedes, address as_) internal returns (bytes32) {
        vm.prank(as_);
        return reg.register(docHash, docType, PROJECT, supersedes, _parties());
    }

    function _sig(uint256 key, bytes32 id) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, reg.signDigest(id));
        return abi.encodePacked(r, s, v);
    }

    // ------------------------------------------------------------ happy path

    function test_RegisterThenBothSignDirectly_Attested() public {
        bytes32 id = _register(DOC, 3, bytes32(0), contractor);
        BuildProofRegistry.Attestation memory a = reg.getAttestation(id);
        assertEq(uint8(a.status), uint8(BuildProofRegistry.Status.Pending));
        assertEq(a.docHash, DOC);
        assertEq(a.signerCount, 2);

        vm.prank(contractor);
        reg.sign(id);
        vm.expectEmit(true, true, false, false);
        emit Attested(id, DOC);
        vm.prank(client);
        reg.sign(id);

        a = reg.getAttestation(id);
        assertEq(uint8(a.status), uint8(BuildProofRegistry.Status.Attested));
        assertEq(a.signedCount, 2);
        assertEq(a.closedAt, block.timestamp);

        (address[] memory s, uint8[] memory st) = reg.getSigners(id);
        assertEq(s.length, 2);
        assertEq(st[0], 2);
        assertEq(st[1], 2);
    }

    function test_SignBySig_RelayerPaysGas() public {
        bytes32 id = _register(DOC, 3, bytes32(0), contractor);
        // A stranger relays both signatures; parties never send a transaction.
        vm.startPrank(stranger);
        reg.signBySig(id, client, _sig(clientKey, id));
        reg.signBySig(id, contractor, _sig(contractorKey, id));
        vm.stopPrank();
        assertEq(uint8(reg.getAttestation(id).status), uint8(BuildProofRegistry.Status.Attested));
    }

    function test_LookupByHash() public {
        bytes32 id = _register(DOC, 3, bytes32(0), contractor);
        bytes32[] memory ids = reg.attestationsOf(DOC);
        assertEq(ids.length, 1);
        assertEq(ids[0], id);
        assertEq(reg.attestationsOf(keccak256("tampered")).length, 0);
    }

    // ------------------------------------------------------------ signatures

    function test_RevertWhen_SignatureFromWrongKey() public {
        bytes32 id = _register(DOC, 3, bytes32(0), contractor);
        bytes memory forged = _sig(supervisorKey, id); // supervisor signs, claims to be client
        vm.expectRevert(BuildProofRegistry.BadSignature.selector);
        reg.signBySig(id, client, forged);
    }

    function test_RevertWhen_SignatureReplayedOnOtherAttestation() public {
        bytes32 id1 = _register(DOC, 3, bytes32(0), contractor);
        bytes32 id2 = _register(keccak256("act no. 2"), 3, bytes32(0), contractor);
        bytes memory sigFor1 = _sig(clientKey, id1);
        vm.expectRevert(BuildProofRegistry.BadSignature.selector);
        reg.signBySig(id2, client, sigFor1);
    }

    function test_RevertWhen_HighSMalleableSignature() public {
        bytes32 id = _register(DOC, 3, bytes32(0), contractor);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(clientKey, reg.signDigest(id));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 sHigh = bytes32(n - uint256(s));
        uint8 vFlip = v == 27 ? 28 : 27;
        vm.expectRevert(BuildProofRegistry.BadSignature.selector);
        reg.signBySig(id, client, abi.encodePacked(r, sHigh, vFlip));
    }

    function test_RevertWhen_SigningTwice() public {
        bytes32 id = _register(DOC, 3, bytes32(0), contractor);
        vm.startPrank(contractor);
        reg.sign(id);
        vm.expectRevert(abi.encodeWithSelector(BuildProofRegistry.AlreadySigned.selector, contractor));
        reg.sign(id);
        vm.stopPrank();
    }

    function test_RevertWhen_StrangerSigns() public {
        bytes32 id = _register(DOC, 3, bytes32(0), contractor);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BuildProofRegistry.NotARequiredSigner.selector, stranger));
        reg.sign(id);
    }

    // ------------------------------------------------------------ registration rules

    function test_RevertWhen_DuplicateRegistration() public {
        bytes32 id = _register(DOC, 3, bytes32(0), contractor);
        vm.expectRevert(abi.encodeWithSelector(BuildProofRegistry.AlreadyRegistered.selector, id));
        _register(DOC, 3, bytes32(0), contractor);
    }

    function test_GriefingRegistrationDoesNotBlockRealOne() public {
        // A stranger front-runs with the same hash and fake signers.
        address[] memory fake = new address[](1);
        fake[0] = stranger;
        vm.prank(stranger);
        bytes32 fakeId = reg.register(DOC, 3, PROJECT, bytes32(0), fake);
        vm.prank(stranger);
        reg.sign(fakeId);

        bytes32 realId = _register(DOC, 3, bytes32(0), contractor);
        assertTrue(realId != fakeId);
        assertEq(reg.attestationsOf(DOC).length, 2);
        // The verifier sees two records and checks signer addresses: only realId has client+contractor.
        (address[] memory s,) = reg.getSigners(fakeId);
        assertEq(s[0], stranger);
    }

    function test_RevertWhen_BadSignerLists() public {
        address[] memory empty = new address[](0);
        vm.expectRevert(BuildProofRegistry.BadSignerList.selector);
        reg.register(DOC, 3, PROJECT, bytes32(0), empty);

        address[] memory dup = new address[](2);
        dup[0] = client;
        dup[1] = client;
        vm.expectRevert(BuildProofRegistry.BadSignerList.selector);
        reg.register(DOC, 3, PROJECT, bytes32(0), dup);

        address[] memory zero = new address[](1);
        vm.expectRevert(BuildProofRegistry.BadSignerList.selector);
        reg.register(DOC, 3, PROJECT, bytes32(0), zero);

        address[] memory tooMany = new address[](17);
        for (uint256 i = 0; i < 17; i++) tooMany[i] = address(uint160(i + 1));
        vm.expectRevert(BuildProofRegistry.BadSignerList.selector);
        reg.register(DOC, 3, PROJECT, bytes32(0), tooMany);
    }

    function test_RevertWhen_ZeroHash() public {
        vm.expectRevert(BuildProofRegistry.ZeroHash.selector);
        reg.register(bytes32(0), 3, PROJECT, bytes32(0), _parties());
    }

    // ------------------------------------------------------------ reject

    function test_RejectClosesAttestation() public {
        bytes32 id = _register(DOC, 3, bytes32(0), contractor);
        vm.prank(contractor);
        reg.sign(id);
        bytes32 reason = keccak256("line 2: quantity x rate != amount");
        vm.expectEmit(true, true, false, true);
        emit Rejected(id, client, reason);
        vm.prank(client);
        reg.reject(id, reason);
        assertEq(uint8(reg.getAttestation(id).status), uint8(BuildProofRegistry.Status.Rejected));

        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(BuildProofRegistry.NotPending.selector, id));
        reg.sign(id);
    }

    function test_RevertWhen_SignerRejectsAfterSigning() public {
        bytes32 id = _register(DOC, 3, bytes32(0), contractor);
        vm.startPrank(contractor);
        reg.sign(id);
        vm.expectRevert(abi.encodeWithSelector(BuildProofRegistry.AlreadySigned.selector, contractor));
        reg.reject(id, bytes32(0));
        vm.stopPrank();
    }

    // ------------------------------------------------------------ amendments

    function _attest(bytes32 id) internal {
        vm.prank(client);
        reg.sign(id);
        vm.prank(contractor);
        reg.sign(id);
    }

    function test_SupplementaryAgreementSupersedesContract() public {
        bytes32 contractId = _register(keccak256("contract"), 1, bytes32(0), client);
        _attest(contractId);

        bytes32 saId = _register(keccak256("supplementary agreement no. 1"), 2, contractId, client);
        assertEq(reg.supersededBy(contractId), bytes32(0)); // not until the amendment is attested
        vm.prank(client);
        reg.sign(saId);
        vm.expectEmit(true, true, false, false);
        emit Superseded(contractId, saId);
        vm.prank(contractor);
        reg.sign(saId);
        assertEq(reg.supersededBy(contractId), saId);
    }

    function test_RevertWhen_SupersedingPendingDocument() public {
        bytes32 contractId = _register(keccak256("contract"), 1, bytes32(0), client);
        vm.expectRevert(abi.encodeWithSelector(BuildProofRegistry.BadSupersedes.selector, contractId));
        _register(keccak256("sa"), 2, contractId, client);
    }

    function test_RevertWhen_StrangerSupersedes() public {
        bytes32 contractId = _register(keccak256("contract"), 1, bytes32(0), client);
        _attest(contractId);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BuildProofRegistry.BadSupersedes.selector, contractId));
        reg.register(keccak256("fake sa"), 2, PROJECT, contractId, _parties());
    }

    function test_RevertWhen_SupersedingTwice() public {
        bytes32 contractId = _register(keccak256("contract"), 1, bytes32(0), client);
        _attest(contractId);
        bytes32 sa1 = _register(keccak256("sa1"), 2, contractId, client);
        _attest(sa1);
        vm.expectRevert(abi.encodeWithSelector(BuildProofRegistry.BadSupersedes.selector, contractId));
        _register(keccak256("sa2"), 2, contractId, client);
    }

    // ------------------------------------------------------------ fuzz

    function testFuzz_OnlyListedSignersCanSign(address who) public {
        vm.assume(who != client && who != contractor);
        bytes32 id = _register(DOC, 3, bytes32(0), contractor);
        vm.prank(who);
        vm.expectRevert(abi.encodeWithSelector(BuildProofRegistry.NotARequiredSigner.selector, who));
        reg.sign(id);
    }

    function testFuzz_DifferentHashesNeverCollide(bytes32 h1, bytes32 h2) public {
        vm.assume(h1 != h2 && h1 != bytes32(0) && h2 != bytes32(0));
        bytes32 id1 = _register(h1, 3, bytes32(0), contractor);
        bytes32 id2 = _register(h2, 3, bytes32(0), contractor);
        assertTrue(id1 != id2);
        assertEq(reg.attestationsOf(h1)[0], id1);
        assertEq(reg.attestationsOf(h2)[0], id2);
    }
}
