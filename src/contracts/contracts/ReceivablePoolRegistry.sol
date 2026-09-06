// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.22;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAtSnapshot, IAssociablePayout, IExactSnapshotPayout, IPayoutBinding} from "./interfaces/IReceivableXExternal.sol";

contract ReceivablePoolRegistry is AccessControl, Pausable, ReentrancyGuard {
    bytes32 public constant POOL_MANAGER_ROLE = keccak256("receivablex.role.pool-manager");
    bytes32 public constant SERVICER_ROLE = keccak256("receivablex.role.servicer");
    bytes32 public constant TRUSTEE_ROLE = keccak256("receivablex.role.trustee");
    bytes32 public constant PAYOUT_EXECUTOR_ROLE = keccak256("receivablex.role.payout-executor");
    bytes32 public constant PAUSER_ROLE = keccak256("receivablex.role.pauser");

    enum PoolStatus { Draft, Active, Amortizing, Matured, Closed }
    enum ReceivableStatus { None, Performing, Delinquent, Defaulted, WrittenOff, Paid }
    enum DistributionStatus { None, Approved, PartiallyPaid, Paid, Finalized, Cancelled }

    struct PoolCommitment {
        bytes32 poolId;
        bytes32 poolRoot;
        bytes32 eligibilityRoot;
        bytes32 manifestHash;
        bytes32 assignmentDocumentHash;
        address originator;
        address trustee;
        uint256 originalFaceValue;
        uint256 originalInvestorPrincipal;
        uint256 totalUnits;
        uint256 retainedUnitsAtIssuance;
        uint64 maturity;
    }

    struct Pool {
        bytes32 poolRoot;
        bytes32 eligibilityRoot;
        bytes32 manifestHash;
        bytes32 assignmentDocumentHash;
        address atsSecurity;
        address payoutContract;
        address paymentToken;
        address originator;
        address trustee;
        uint256 originalFaceValue;
        uint256 performingFaceOutstanding;
        uint256 delinquentFaceOutstanding;
        uint256 defaultedFaceOutstanding;
        uint256 estimatedDefaultRecoveries;
        uint256 realizedLosses;
        uint256 originalInvestorPrincipal;
        uint256 investorPrincipalOutstanding;
        uint256 availableCash;
        uint256 reservedCash;
        uint256 reservedPrincipal;
        uint256 totalCashPaid;
        uint256 totalUnits;
        uint256 retainedUnitsAtIssuance;
        uint64 maturity;
        PoolStatus status;
        bool exists;
    }

    struct ReceivableLeaf {
        uint8 schemaVersion;
        bytes32 fuIdHash;
        bytes32 obligorIdHash;
        uint256 faceValue;
        uint64 dueDate;
        bytes3 currency;
        uint64 acceptedAt;
        bytes32 evidenceHash;
    }

    struct Entitlement {
        address holder;
        uint256 snapshotBalance;
        uint256 cashAmount;
        uint256 principalAmount;
        uint256 incomeAmount;
    }

    struct Distribution {
        bytes32 poolId;
        bytes32 entitlementRoot;
        uint256 snapshotId;
        uint256 snapshotSupply;
        uint256 principalBudget;
        uint256 incomeBudget;
        uint256 immutablePayoutTotal;
        uint256 allocatedPrincipal;
        uint256 allocatedIncome;
        uint256 allocatedCash;
        uint256 cashPaid;
        uint256 principalPaid;
        uint256 incomePaid;
        uint32 holderCount;
        uint32 paidCount;
        uint64 approvedAt;
        DistributionStatus status;
    }

    mapping(bytes32 => Pool) private pools;
    mapping(bytes32 => bytes32) public collectionPayloadHash;
    mapping(bytes32 => bytes32) public collectionPool;
    mapping(bytes32 => mapping(bytes32 => uint256)) public collectedByReceivable;
    mapping(bytes32 => mapping(bytes32 => ReceivableStatus)) public receivableStatus;
    mapping(bytes32 => mapping(bytes32 => uint256)) public estimatedRecoveryByReceivable;
    mapping(bytes32 => bytes32) public servicingPayloadHash;
    mapping(bytes32 => Distribution) private distributions;
    mapping(address => mapping(uint256 => bool)) public snapshotBound;
    mapping(bytes32 => mapping(address => bool)) public holderPaid;

    // payloadHash commits the application's canonical external event. It is not
    // proof that the caller supplied the same executable arguments on a retry.
    // Bind those separately, in independent collection and servicing namespaces.
    // Keep these appended so existing storage declarations retain their order.
    mapping(bytes32 => bytes32) private collectionExecutionHash;
    mapping(bytes32 => bytes32) private servicingExecutionHash;
    // MVP custody is deliberately single-pool. No reset/reassignment exists:
    // an adapter balance must never collateralize two accounting ledgers.
    bytes32 public activePoolId;
    mapping(bytes32 => uint256) public pendingDistributions;
    mapping(address => bytes32) public payoutCustodyOwner;
    mapping(bytes32 => mapping(bytes32 => uint256)) public writtenOffByReceivable;
    mapping(bytes32 => uint256) public totalPrincipalWrittenDown;
    mapping(bytes32 => uint256) public zeroEntitlementCount;

    error InvalidAddress();
    error InvalidAmount();
    error InvalidState();
    error PoolAlreadyExists();
    error PoolNotFound();
    error InvalidReceivableProof();
    error CollectionExceedsOutstanding();
    error ConflictingCollectionEvent();
    error ConflictingServicingEvent();
    error InsufficientCashCoverage();
    error DistributionAlreadyExists();
    error DistributionNotPayable();
    error SnapshotAlreadyBound();
    error SnapshotBalanceMismatch();
    error EntitlementInvalid();
    error EntitlementProofInvalid();
    error PayoutResultInvalid();
    error ActivePoolAlreadyExists();
    error InvalidPayoutBinding();
    error ReceivableNotDue();
    error PoolNotMature();
    error UnresolvedPoolObligations();
    error PayoutCustodyAlreadyBound();
    error UnsupportedPayoutVersion();

    event PoolCreated(bytes32 indexed poolId, bytes32 indexed poolRoot, address indexed originator);
    event PoolActivated(bytes32 indexed poolId, address indexed atsSecurity, address indexed payoutContract);
    event PayoutAdapterInitialized(bytes32 indexed poolId, address indexed payoutContract);
    event CollectionRecorded(bytes32 indexed poolId, bytes32 indexed sourceEventId, bytes32 indexed fuIdHash, uint256 amount);
    event CollectionReplayIgnored(bytes32 indexed poolId, bytes32 indexed sourceEventId);
    event ServicingReplayIgnored(bytes32 indexed poolId, bytes32 indexed sourceEventId);
    event ReceivableDelinquent(bytes32 indexed poolId, bytes32 indexed sourceEventId, bytes32 indexed fuIdHash, uint256 face);
    event ReceivableDefaulted(bytes32 indexed poolId, bytes32 indexed sourceEventId, bytes32 indexed fuIdHash, uint256 face, uint256 estimatedRecovery);
    event ReceivableCured(bytes32 indexed poolId, bytes32 indexed sourceEventId, bytes32 indexed fuIdHash, uint256 face);
    event RecoveryEstimateRevised(bytes32 indexed poolId, bytes32 indexed sourceEventId, bytes32 indexed fuIdHash, uint256 previousEstimate, uint256 estimatedRecovery);
    event PoolMatured(bytes32 indexed poolId);
    event PoolClosed(bytes32 indexed poolId);
    event ReceivableWrittenOff(bytes32 indexed poolId, bytes32 indexed sourceEventId, bytes32 indexed fuIdHash, uint256 face, uint256 removedRecovery, bytes32 decisionHash);
    event PrincipalWrittenDown(bytes32 indexed poolId, bytes32 indexed sourceEventId, uint256 amount, bytes32 decisionHash);
    event DistributionCancelled(bytes32 indexed distributionId, bytes32 indexed poolId, bytes32 indexed sourceEventId, uint256 releasedCash, uint256 releasedPrincipal, bytes32 decisionHash);
    event DistributionApproved(bytes32 indexed distributionId, bytes32 indexed poolId, uint256 snapshotId, uint256 total);
    event HolderPaid(bytes32 indexed distributionId, address indexed holder, uint256 cash, uint256 principal, uint256 income);
    event HolderNoPaymentDue(bytes32 indexed distributionId, address indexed holder);
    event DistributionBatchExecuted(bytes32 indexed distributionId, uint256 succeeded, uint256 failed);
    event DistributionFinalized(bytes32 indexed distributionId, uint256 roundingDust, uint256 principalRemainder);

    constructor(address admin) {
        if (admin == address(0)) revert InvalidAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(POOL_MANAGER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }
    function servicingVersion() external pure returns (uint256) { return 2; }
    function distributionVersion() external pure returns (uint256) { return 3; }
    function lifecycleVersion() external pure returns (uint256) { return 1; }
    function exceptionsVersion() external pure returns (uint256) { return 1; }

    function createPool(PoolCommitment calldata commitment) external onlyRole(POOL_MANAGER_ROLE) whenNotPaused {
        if (pools[commitment.poolId].exists) revert PoolAlreadyExists();
        if (commitment.poolId == bytes32(0) || commitment.poolRoot == bytes32(0)) revert InvalidState();
        if (commitment.originator == address(0) || commitment.trustee == address(0)) revert InvalidAddress();
        if (
            commitment.originalFaceValue == 0 ||
            commitment.originalInvestorPrincipal == 0 ||
            commitment.totalUnits == 0 ||
            commitment.retainedUnitsAtIssuance > commitment.totalUnits
        ) revert InvalidAmount();

        Pool storage pool = pools[commitment.poolId];
        pool.poolRoot = commitment.poolRoot;
        pool.eligibilityRoot = commitment.eligibilityRoot;
        pool.manifestHash = commitment.manifestHash;
        pool.assignmentDocumentHash = commitment.assignmentDocumentHash;
        pool.originator = commitment.originator;
        pool.trustee = commitment.trustee;
        pool.originalFaceValue = commitment.originalFaceValue;
        pool.performingFaceOutstanding = commitment.originalFaceValue;
        pool.originalInvestorPrincipal = commitment.originalInvestorPrincipal;
        pool.investorPrincipalOutstanding = commitment.originalInvestorPrincipal;
        pool.totalUnits = commitment.totalUnits;
        pool.retainedUnitsAtIssuance = commitment.retainedUnitsAtIssuance;
        pool.maturity = commitment.maturity;
        pool.status = PoolStatus.Draft;
        pool.exists = true;
        emit PoolCreated(commitment.poolId, commitment.poolRoot, commitment.originator);
    }

    function activatePool(bytes32 poolId, address atsSecurity, address payoutContract, address paymentToken)
        external
        onlyRole(POOL_MANAGER_ROLE)
        whenNotPaused
    {
        Pool storage pool = _pool(poolId);
        if (pool.status != PoolStatus.Draft) revert InvalidState();
        if (activePoolId != bytes32(0)) revert ActivePoolAlreadyExists();
        if (payoutCustodyOwner[payoutContract] != bytes32(0)) revert PayoutCustodyAlreadyBound();
        if (atsSecurity == address(0) || payoutContract == address(0) || paymentToken == address(0)) revert InvalidAddress();
        // Native HTS tokens use a system-contract facade, not deployed ERC20 bytecode.
        if (atsSecurity.code.length == 0 || payoutContract.code.length == 0) {
            revert InvalidPayoutBinding();
        }
        IPayoutBinding binding = IPayoutBinding(payoutContract);
        if (
            binding.asset() != atsSecurity || binding.paymentToken() != paymentToken ||
            binding.operator() != address(this)
        ) revert InvalidPayoutBinding();
        try IExactSnapshotPayout(payoutContract).exactPayoutVersion() returns (uint256 version) {
            if (version != 1) revert UnsupportedPayoutVersion();
        } catch { revert UnsupportedPayoutVersion(); }
        pool.atsSecurity = atsSecurity;
        pool.payoutContract = payoutContract;
        pool.paymentToken = paymentToken;
        pool.status = PoolStatus.Active;
        activePoolId = poolId;
        payoutCustodyOwner[payoutContract] = poolId;
        emit PoolActivated(poolId, atsSecurity, payoutContract);
    }

    function initializePayoutAdapter(bytes32 poolId) external onlyRole(POOL_MANAGER_ROLE) whenNotPaused {
        Pool storage pool = _activePool(poolId);
        IAssociablePayout(pool.payoutContract).associatePaymentToken();
        emit PayoutAdapterInitialized(poolId, pool.payoutContract);
    }

    function recordCollection(
        bytes32 poolId,
        bytes32 sourceEventId,
        bytes32 payloadHash,
        uint256 amount,
        ReceivableLeaf calldata leaf,
        bytes32[] calldata proof
    ) external onlyRole(SERVICER_ROLE) whenNotPaused {
        Pool storage pool = _activePool(poolId);
        bytes32 executionHash = keccak256(abi.encode(msg.sig, poolId, sourceEventId, payloadHash, amount, leaf, proof));
        bytes32 existing = collectionPayloadHash[sourceEventId];
        if (existing != bytes32(0)) {
            if (
                existing != payloadHash || collectionPool[sourceEventId] != poolId ||
                collectionExecutionHash[sourceEventId] != executionHash
            ) revert ConflictingCollectionEvent();
            emit CollectionReplayIgnored(poolId, sourceEventId);
            return;
        }
        if (sourceEventId == bytes32(0) || payloadHash == bytes32(0) || amount == 0) revert InvalidAmount();
        if (!MerkleProof.verifyCalldata(proof, pool.poolRoot, hashReceivableLeaf(leaf))) revert InvalidReceivableProof();
        uint256 alreadyCollected = collectedByReceivable[poolId][leaf.fuIdHash];
        if (receivableStatus[poolId][leaf.fuIdHash] == ReceivableStatus.WrittenOff) revert InvalidState();
        if (amount > leaf.faceValue - alreadyCollected) {
            revert CollectionExceedsOutstanding();
        }
        if (IERC20(pool.paymentToken).balanceOf(pool.payoutContract) < pool.availableCash + pool.reservedCash + amount) {
            revert InsufficientCashCoverage();
        }

        collectionPayloadHash[sourceEventId] = payloadHash;
        collectionPool[sourceEventId] = poolId;
        collectionExecutionHash[sourceEventId] = executionHash;
        collectedByReceivable[poolId][leaf.fuIdHash] = alreadyCollected + amount;
        ReceivableStatus status = receivableStatus[poolId][leaf.fuIdHash];
        if (status == ReceivableStatus.Delinquent) {
            if (amount > pool.delinquentFaceOutstanding) revert CollectionExceedsOutstanding();
            pool.delinquentFaceOutstanding -= amount;
        } else if (status == ReceivableStatus.Defaulted) {
            if (amount > pool.defaultedFaceOutstanding) revert CollectionExceedsOutstanding();
            pool.defaultedFaceOutstanding -= amount;
            uint256 estimate = estimatedRecoveryByReceivable[poolId][leaf.fuIdHash];
            uint256 reduction = amount < estimate ? amount : estimate;
            estimatedRecoveryByReceivable[poolId][leaf.fuIdHash] = estimate - reduction;
            pool.estimatedDefaultRecoveries -= reduction;
        } else {
            if (amount > pool.performingFaceOutstanding) revert CollectionExceedsOutstanding();
            pool.performingFaceOutstanding -= amount;
        }
        pool.availableCash += amount;
        receivableStatus[poolId][leaf.fuIdHash] = alreadyCollected + amount == leaf.faceValue
            ? ReceivableStatus.Paid
            : status == ReceivableStatus.None ? ReceivableStatus.Performing : status;
        if (pool.status == PoolStatus.Active) pool.status = PoolStatus.Amortizing;
        emit CollectionRecorded(poolId, sourceEventId, leaf.fuIdHash, amount);
    }

    function markDelinquent(
        bytes32 poolId,
        bytes32 sourceEventId,
        bytes32 payloadHash,
        ReceivableLeaf calldata leaf,
        bytes32[] calldata proof
    ) external onlyRole(SERVICER_ROLE) whenNotPaused {
        Pool storage pool = _activePool(poolId);
        bytes32 executionHash = keccak256(abi.encode(msg.sig, poolId, sourceEventId, payloadHash, leaf, proof));
        if (!_consumeServicingEvent(poolId, sourceEventId, payloadHash, executionHash)) return;
        if (!MerkleProof.verifyCalldata(proof, pool.poolRoot, hashReceivableLeaf(leaf))) revert InvalidReceivableProof();
        ReceivableStatus status = receivableStatus[poolId][leaf.fuIdHash];
        if (status != ReceivableStatus.None && status != ReceivableStatus.Performing) revert InvalidState();
        if (block.timestamp <= leaf.dueDate) revert ReceivableNotDue();
        uint256 outstanding = leaf.faceValue - collectedByReceivable[poolId][leaf.fuIdHash];
        if (outstanding == 0 || outstanding > pool.performingFaceOutstanding) revert InvalidAmount();
        pool.performingFaceOutstanding -= outstanding;
        pool.delinquentFaceOutstanding += outstanding;
        receivableStatus[poolId][leaf.fuIdHash] = ReceivableStatus.Delinquent;
        emit ReceivableDelinquent(poolId, sourceEventId, leaf.fuIdHash, outstanding);
    }

    function markDefault(
        bytes32 poolId,
        bytes32 sourceEventId,
        bytes32 payloadHash,
        uint256 estimatedRecovery,
        ReceivableLeaf calldata leaf,
        bytes32[] calldata proof
    ) external onlyRole(TRUSTEE_ROLE) whenNotPaused {
        Pool storage pool = _activePool(poolId);
        bytes32 executionHash = keccak256(abi.encode(msg.sig, poolId, sourceEventId, payloadHash, estimatedRecovery, leaf, proof));
        if (!_consumeServicingEvent(poolId, sourceEventId, payloadHash, executionHash)) return;
        if (!MerkleProof.verifyCalldata(proof, pool.poolRoot, hashReceivableLeaf(leaf))) revert InvalidReceivableProof();
        if (receivableStatus[poolId][leaf.fuIdHash] != ReceivableStatus.Delinquent) revert InvalidState();
        uint256 outstanding = leaf.faceValue - collectedByReceivable[poolId][leaf.fuIdHash];
        if (outstanding == 0 || outstanding > pool.delinquentFaceOutstanding || estimatedRecovery > outstanding) {
            revert InvalidAmount();
        }
        pool.delinquentFaceOutstanding -= outstanding;
        pool.defaultedFaceOutstanding += outstanding;
        pool.estimatedDefaultRecoveries += estimatedRecovery;
        estimatedRecoveryByReceivable[poolId][leaf.fuIdHash] = estimatedRecovery;
        receivableStatus[poolId][leaf.fuIdHash] = ReceivableStatus.Defaulted;
        emit ReceivableDefaulted(poolId, sourceEventId, leaf.fuIdHash, outstanding, estimatedRecovery);
    }

    function cureReceivable(
        bytes32 poolId, bytes32 sourceEventId, bytes32 payloadHash,
        ReceivableLeaf calldata leaf, bytes32[] calldata proof
    ) external onlyRole(TRUSTEE_ROLE) whenNotPaused {
        Pool storage pool = _activePool(poolId);
        bytes32 executionHash = keccak256(abi.encode(msg.sig, poolId, sourceEventId, payloadHash, leaf, proof));
        if (!_consumeServicingEvent(poolId, sourceEventId, payloadHash, executionHash)) return;
        if (!MerkleProof.verifyCalldata(proof, pool.poolRoot, hashReceivableLeaf(leaf))) revert InvalidReceivableProof();
        ReceivableStatus status = receivableStatus[poolId][leaf.fuIdHash];
        uint256 outstanding = leaf.faceValue - collectedByReceivable[poolId][leaf.fuIdHash];
        if (status == ReceivableStatus.Delinquent) {
            pool.delinquentFaceOutstanding -= outstanding;
        } else if (status == ReceivableStatus.Defaulted) {
            pool.defaultedFaceOutstanding -= outstanding;
            pool.estimatedDefaultRecoveries -= estimatedRecoveryByReceivable[poolId][leaf.fuIdHash];
            estimatedRecoveryByReceivable[poolId][leaf.fuIdHash] = 0;
        } else revert InvalidState();
        if (outstanding == 0) revert InvalidAmount();
        pool.performingFaceOutstanding += outstanding;
        receivableStatus[poolId][leaf.fuIdHash] = ReceivableStatus.Performing;
        emit ReceivableCured(poolId, sourceEventId, leaf.fuIdHash, outstanding);
    }

    function reviseRecoveryEstimate(
        bytes32 poolId, bytes32 sourceEventId, bytes32 payloadHash, uint256 estimatedRecovery,
        ReceivableLeaf calldata leaf, bytes32[] calldata proof
    ) external onlyRole(TRUSTEE_ROLE) whenNotPaused {
        Pool storage pool = _activePool(poolId);
        bytes32 executionHash = keccak256(abi.encode(msg.sig, poolId, sourceEventId, payloadHash, estimatedRecovery, leaf, proof));
        if (!_consumeServicingEvent(poolId, sourceEventId, payloadHash, executionHash)) return;
        if (!MerkleProof.verifyCalldata(proof, pool.poolRoot, hashReceivableLeaf(leaf))) revert InvalidReceivableProof();
        if (receivableStatus[poolId][leaf.fuIdHash] != ReceivableStatus.Defaulted) revert InvalidState();
        if (estimatedRecovery > leaf.faceValue - collectedByReceivable[poolId][leaf.fuIdHash]) revert InvalidAmount();
        uint256 previous = estimatedRecoveryByReceivable[poolId][leaf.fuIdHash];
        pool.estimatedDefaultRecoveries = pool.estimatedDefaultRecoveries - previous + estimatedRecovery;
        estimatedRecoveryByReceivable[poolId][leaf.fuIdHash] = estimatedRecovery;
        emit RecoveryEstimateRevised(poolId, sourceEventId, leaf.fuIdHash, previous, estimatedRecovery);
    }

    function approveDistribution(
        bytes32 poolId,
        bytes32 distributionId,
        uint256 snapshotId,
        uint256 principalBudget,
        uint256 incomeBudget,
        Entitlement[] calldata entitlements
    ) external onlyRole(TRUSTEE_ROLE) whenNotPaused {
        Pool storage pool = _activePool(poolId);
        if (distributions[distributionId].status != DistributionStatus.None) revert DistributionAlreadyExists();
        if (snapshotBound[pool.payoutContract][snapshotId]) revert SnapshotAlreadyBound();
        uint256 total = principalBudget + incomeBudget;
        if (
            distributionId == bytes32(0) ||
            total == 0 ||
            total > pool.availableCash ||
            principalBudget > pool.investorPrincipalOutstanding - pool.reservedPrincipal ||
            entitlements.length == 0 ||
            entitlements.length > 32
        ) revert InvalidAmount();

        IAtSnapshot asset = IAtSnapshot(pool.atsSecurity);
        uint256 unreservedPrincipal = pool.investorPrincipalOutstanding - pool.reservedPrincipal;
        if (principalBudget != (total < unreservedPrincipal ? total : unreservedPrincipal)) revert InvalidAmount();
        uint256 supply = asset.totalSupplyAtSnapshot(snapshotId);
        if (supply == 0) revert SnapshotBalanceMismatch();
        bytes32[] memory leaves = new bytes32[](entitlements.length);
        uint256 balanceSum;
        uint256 cashSum;
        uint256 principalSum;
        uint256 incomeSum;
        uint256 floorCashSum;
        uint256 floorPrincipalSum;
        uint256 floorIncomeSum;
        uint256[] memory cashFloors = new uint256[](entitlements.length);
        uint256[] memory remainders = new uint256[](entitlements.length);
        uint256[] memory principalFloors = new uint256[](entitlements.length);
        uint256[] memory incomeFloors = new uint256[](entitlements.length);
        address previous;
        for (uint256 i; i < entitlements.length; ++i) {
            Entitlement calldata entry = entitlements[i];
            if (entry.holder <= previous || entry.holder == address(0)) revert EntitlementInvalid();
            if (asset.balanceOfAtSnapshot(snapshotId, entry.holder) != entry.snapshotBalance) {
                revert SnapshotBalanceMismatch();
            }
            if (entry.snapshotBalance == 0 || entry.snapshotBalance > supply - balanceSum) revert SnapshotBalanceMismatch();
            previous = entry.holder;
            balanceSum += entry.snapshotBalance;
            cashFloors[i] = Math.mulDiv(total, entry.snapshotBalance, supply);
            remainders[i] = mulmod(total, entry.snapshotBalance, supply);
            principalFloors[i] = Math.mulDiv(principalBudget, entry.snapshotBalance, supply);
            incomeFloors[i] = Math.mulDiv(incomeBudget, entry.snapshotBalance, supply);
            floorCashSum += cashFloors[i];
            floorPrincipalSum += principalFloors[i];
            floorIncomeSum += incomeFloors[i];
            leaves[i] = hashEntitlement(entry);
        }
        if (balanceSum != supply) revert SnapshotBalanceMismatch();
        uint256 residual = total - floorCashSum;
        uint256 principalCapacity = principalBudget - floorPrincipalSum;
        uint256 incomeCapacity = incomeBudget - floorIncomeSum;
        for (uint256 i; i < entitlements.length; ++i) {
            uint256 rank;
            for (uint256 j; j < entitlements.length; ++j) {
                if (remainders[j] > remainders[i] || (remainders[j] == remainders[i] && j < i)) ++rank;
            }
            uint256 cash = cashFloors[i] + (rank < residual ? 1 : 0);
            uint256 principal = principalFloors[i];
            uint256 income = incomeFloors[i];
            uint256 gap = cash - principal - income;
            uint256 assigned = Math.min(gap, principalCapacity);
            principal += assigned; principalCapacity -= assigned; gap -= assigned;
            assigned = Math.min(gap, incomeCapacity);
            income += assigned; incomeCapacity -= assigned; gap -= assigned;
            Entitlement calldata entry = entitlements[i];
            if (gap != 0 || entry.cashAmount != cash || entry.principalAmount != principal || entry.incomeAmount != income) revert EntitlementInvalid();
            cashSum += cash; principalSum += principal; incomeSum += income;
        }
        if (cashSum != total || principalSum != principalBudget || incomeSum != incomeBudget) revert EntitlementInvalid();

        Distribution storage distribution = distributions[distributionId];
        distribution.poolId = poolId;
        distribution.entitlementRoot = _merkleRoot(leaves);
        distribution.snapshotId = snapshotId;
        distribution.snapshotSupply = supply;
        distribution.principalBudget = principalBudget;
        distribution.incomeBudget = incomeBudget;
        distribution.immutablePayoutTotal = total;
        distribution.allocatedPrincipal = principalSum;
        distribution.allocatedIncome = incomeSum;
        distribution.allocatedCash = cashSum;
        distribution.holderCount = uint32(entitlements.length);
        distribution.approvedAt = uint64(block.timestamp);
        distribution.status = DistributionStatus.Approved;
        snapshotBound[pool.payoutContract][snapshotId] = true;
        pendingDistributions[poolId] += 1;
        pool.availableCash -= total;
        pool.reservedCash += total;
        pool.reservedPrincipal += principalBudget;
        for (uint256 i; i < entitlements.length; ++i) {
            if (entitlements[i].cashAmount == 0) {
                holderPaid[distributionId][entitlements[i].holder] = true;
                ++distribution.paidCount;
                ++zeroEntitlementCount[distributionId];
                emit HolderNoPaymentDue(distributionId, entitlements[i].holder);
            }
        }
        emit DistributionApproved(distributionId, poolId, snapshotId, total);
    }

    function executeDistributionBatch(
        bytes32 distributionId,
        Entitlement[] calldata entries,
        bytes32[][] calldata proofs
    ) external onlyRole(PAYOUT_EXECUTOR_ROLE) whenNotPaused nonReentrant {
        Distribution storage distribution = distributions[distributionId];
        if (
            distribution.status != DistributionStatus.Approved &&
            distribution.status != DistributionStatus.PartiallyPaid
        ) revert DistributionNotPayable();
        if (entries.length == 0 || entries.length != proofs.length) revert EntitlementInvalid();
        Pool storage pool = _activePool(distribution.poolId);
        address[] memory holders = new address[](entries.length);
        uint256[] memory exactAmounts = new uint256[](entries.length);
        for (uint256 i; i < entries.length; ++i) {
            if (!MerkleProof.verifyCalldata(proofs[i], distribution.entitlementRoot, hashEntitlement(entries[i]))) {
                revert EntitlementProofInvalid();
            }
            if (holderPaid[distributionId][entries[i].holder]) revert PayoutResultInvalid();
            for (uint256 j; j < i; ++j) if (holders[j] == entries[i].holder) revert PayoutResultInvalid();
            holders[i] = entries[i].holder;
            exactAmounts[i] = entries[i].cashAmount;
        }

        (address[] memory failed, address[] memory succeeded, uint256[] memory paidAmounts) =
            IExactSnapshotPayout(pool.payoutContract).executeExactSnapshotByAddresses(
                pool.atsSecurity,
                distribution.snapshotId,
                holders,
                distribution.immutablePayoutTotal,
                exactAmounts
            );
        if (succeeded.length != paidAmounts.length) revert PayoutResultInvalid();
        uint256 successCount;
        for (uint256 i; i < succeeded.length; ++i) {
            address succeededHolder = succeeded[i];
            if (succeededHolder == address(0)) continue;
            (Entitlement calldata entitlement, bool found) = _findEntitlement(entries, succeededHolder);
            if (!found || paidAmounts[i] != entitlement.cashAmount || holderPaid[distributionId][succeededHolder]) {
                revert PayoutResultInvalid();
            }
            holderPaid[distributionId][succeededHolder] = true;
            ++successCount;
            ++distribution.paidCount;
            distribution.cashPaid += entitlement.cashAmount;
            distribution.principalPaid += entitlement.principalAmount;
            distribution.incomePaid += entitlement.incomeAmount;
            pool.reservedCash -= entitlement.cashAmount;
            pool.reservedPrincipal -= entitlement.principalAmount;
            pool.investorPrincipalOutstanding -= entitlement.principalAmount;
            pool.totalCashPaid += entitlement.cashAmount;
            emit HolderPaid(
                distributionId,
                succeededHolder,
                entitlement.cashAmount,
                entitlement.principalAmount,
                entitlement.incomeAmount
            );
        }
        if (
            distribution.principalPaid > distribution.principalBudget ||
            distribution.incomePaid > distribution.incomeBudget ||
            distribution.cashPaid > distribution.immutablePayoutTotal
        ) revert PayoutResultInvalid();
        distribution.status = distribution.paidCount == distribution.holderCount
            ? DistributionStatus.Paid
            : DistributionStatus.PartiallyPaid;
        emit DistributionBatchExecuted(distributionId, successCount, _nonZeroCount(failed));
    }

    function finalizeDistribution(bytes32 distributionId) external onlyRole(TRUSTEE_ROLE) whenNotPaused {
        Distribution storage distribution = distributions[distributionId];
        if (distribution.status != DistributionStatus.Paid || distribution.paidCount != distribution.holderCount || distribution.cashPaid != distribution.immutablePayoutTotal || distribution.principalPaid != distribution.principalBudget || distribution.incomePaid != distribution.incomeBudget) revert DistributionNotPayable();
        distribution.status = DistributionStatus.Finalized;
        pendingDistributions[distribution.poolId] -= 1;
        emit DistributionFinalized(distributionId, 0, 0);
    }

    function markMatured(bytes32 poolId) external onlyRole(TRUSTEE_ROLE) whenNotPaused {
        Pool storage pool = _activePool(poolId);
        if (block.timestamp < pool.maturity) revert PoolNotMature();
        if (pool.status == PoolStatus.Matured) return;
        pool.status = PoolStatus.Matured;
        emit PoolMatured(poolId);
    }

    function writeOffReceivable(
        bytes32 poolId, bytes32 sourceEventId, bytes32 payloadHash, bytes32 decisionHash,
        ReceivableLeaf calldata leaf, bytes32[] calldata proof
    ) external onlyRole(TRUSTEE_ROLE) whenNotPaused {
        Pool storage pool = _activePool(poolId);
        bytes32 executionHash = keccak256(abi.encode(msg.sig, poolId, sourceEventId, payloadHash, decisionHash, leaf, proof));
        if (!_consumeServicingEvent(poolId, sourceEventId, payloadHash, executionHash)) return;
        if (decisionHash == bytes32(0)) revert InvalidState();
        if (!MerkleProof.verifyCalldata(proof, pool.poolRoot, hashReceivableLeaf(leaf))) revert InvalidReceivableProof();
        if (receivableStatus[poolId][leaf.fuIdHash] != ReceivableStatus.Defaulted) revert InvalidState();
        uint256 outstanding = leaf.faceValue - collectedByReceivable[poolId][leaf.fuIdHash];
        if (outstanding == 0 || outstanding > pool.defaultedFaceOutstanding) revert InvalidAmount();
        uint256 estimate = estimatedRecoveryByReceivable[poolId][leaf.fuIdHash];
        pool.defaultedFaceOutstanding -= outstanding;
        pool.estimatedDefaultRecoveries -= estimate;
        pool.realizedLosses += outstanding;
        writtenOffByReceivable[poolId][leaf.fuIdHash] = outstanding;
        estimatedRecoveryByReceivable[poolId][leaf.fuIdHash] = 0;
        receivableStatus[poolId][leaf.fuIdHash] = ReceivableStatus.WrittenOff;
        emit ReceivableWrittenOff(poolId, sourceEventId, leaf.fuIdHash, outstanding, estimate, decisionHash);
    }

    function writeDownPrincipal(bytes32 poolId, bytes32 sourceEventId, bytes32 payloadHash, uint256 amount, bytes32 decisionHash)
        external onlyRole(TRUSTEE_ROLE) whenNotPaused
    {
        Pool storage pool = _activePool(poolId);
        bytes32 executionHash = keccak256(abi.encode(msg.sig, poolId, sourceEventId, payloadHash, amount, decisionHash));
        if (!_consumeServicingEvent(poolId, sourceEventId, payloadHash, executionHash)) return;
        if (decisionHash == bytes32(0)) revert InvalidState();
        if (amount == 0 || amount > pool.investorPrincipalOutstanding - pool.reservedPrincipal || amount > pool.realizedLosses - totalPrincipalWrittenDown[poolId]) revert InvalidAmount();
        pool.investorPrincipalOutstanding -= amount;
        totalPrincipalWrittenDown[poolId] += amount;
        emit PrincipalWrittenDown(poolId, sourceEventId, amount, decisionHash);
    }

    function cancelDistribution(bytes32 distributionId, bytes32 sourceEventId, bytes32 payloadHash, bytes32 decisionHash)
        external onlyRole(TRUSTEE_ROLE) whenNotPaused
    {
        Distribution storage distribution = distributions[distributionId];
        Pool storage pool = _activePool(distribution.poolId);
        bytes32 executionHash = keccak256(abi.encode(msg.sig, distributionId, sourceEventId, payloadHash, decisionHash));
        if (!_consumeServicingEvent(distribution.poolId, sourceEventId, payloadHash, executionHash)) return;
        if (decisionHash == bytes32(0)) revert InvalidState();
        if ((distribution.status != DistributionStatus.Approved && distribution.status != DistributionStatus.PartiallyPaid) || distribution.paidCount != zeroEntitlementCount[distributionId] || distribution.cashPaid != 0 || distribution.principalPaid != 0 || distribution.incomePaid != 0) revert DistributionNotPayable();
        pool.reservedCash -= distribution.immutablePayoutTotal;
        pool.availableCash += distribution.immutablePayoutTotal;
        pool.reservedPrincipal -= distribution.principalBudget;
        pendingDistributions[distribution.poolId] -= 1;
        distribution.status = DistributionStatus.Cancelled;
        emit DistributionCancelled(distributionId, distribution.poolId, sourceEventId, distribution.immutablePayoutTotal, distribution.principalBudget, decisionHash);
    }

    function closePool(bytes32 poolId) external onlyRole(TRUSTEE_ROLE) whenNotPaused {
        Pool storage pool = _pool(poolId);
        if (pool.status == PoolStatus.Closed) return;
        if (pool.status != PoolStatus.Matured) revert InvalidState();
        if (
            pool.investorPrincipalOutstanding != 0 || pool.availableCash != 0 ||
            pool.reservedCash != 0 || pool.reservedPrincipal != 0 ||
            pool.performingFaceOutstanding != 0 || pool.delinquentFaceOutstanding != 0 ||
            pool.defaultedFaceOutstanding != 0 || pool.estimatedDefaultRecoveries != 0 ||
            pendingDistributions[poolId] != 0 || IAtSnapshot(pool.atsSecurity).totalSupply() != 0 ||
            IERC20(pool.paymentToken).balanceOf(pool.payoutContract) != 0
        ) revert UnresolvedPoolObligations();
        pool.status = PoolStatus.Closed;
        if (activePoolId == poolId) activePoolId = bytes32(0);
        emit PoolClosed(poolId);
    }

    function getPool(bytes32 poolId) external view returns (Pool memory) { return _pool(poolId); }
    function getDistribution(bytes32 distributionId) external view returns (Distribution memory) {
        return distributions[distributionId];
    }

    function hashReceivableLeaf(ReceivableLeaf calldata leaf) public pure returns (bytes32) {
        return keccak256(abi.encode(
            leaf.schemaVersion,
            leaf.fuIdHash,
            leaf.obligorIdHash,
            leaf.faceValue,
            leaf.dueDate,
            leaf.currency,
            leaf.acceptedAt,
            leaf.evidenceHash
        ));
    }

    function hashEntitlement(Entitlement calldata entry) public pure returns (bytes32) {
        return keccak256(abi.encode(
            entry.holder,
            entry.snapshotBalance,
            entry.cashAmount,
            entry.principalAmount,
            entry.incomeAmount
        ));
    }

    function _pool(bytes32 poolId) private view returns (Pool storage pool) {
        pool = pools[poolId];
        if (!pool.exists) revert PoolNotFound();
    }

    function _activePool(bytes32 poolId) private view returns (Pool storage pool) {
        pool = _pool(poolId);
        if (pool.status != PoolStatus.Active && pool.status != PoolStatus.Amortizing && pool.status != PoolStatus.Matured) revert InvalidState();
    }

    function _findEntitlement(Entitlement[] calldata entries, address holder)
        private
        pure
        returns (Entitlement calldata entry, bool found)
    {
        for (uint256 i; i < entries.length; ++i) {
            if (entries[i].holder == holder) return (entries[i], true);
        }
        return (entries[0], false);
    }

    function _nonZeroCount(address[] memory values) private pure returns (uint256 count) {
        for (uint256 i; i < values.length; ++i) if (values[i] != address(0)) ++count;
    }

    function _consumeServicingEvent(bytes32 poolId, bytes32 sourceEventId, bytes32 payloadHash, bytes32 executionHash)
        private
        returns (bool firstSeen)
    {
        if (sourceEventId == bytes32(0) || payloadHash == bytes32(0)) revert InvalidAmount();
        bytes32 existing = servicingPayloadHash[sourceEventId];
        if (existing == bytes32(0)) {
            servicingPayloadHash[sourceEventId] = payloadHash;
            servicingExecutionHash[sourceEventId] = executionHash;
            return true;
        }
        if (existing != payloadHash || servicingExecutionHash[sourceEventId] != executionHash) revert ConflictingServicingEvent();
        emit ServicingReplayIgnored(poolId, sourceEventId);
        return false;
    }

    function _merkleRoot(bytes32[] memory leaves) private pure returns (bytes32) {
        if (leaves.length == 0) return keccak256("");
        for (uint256 i = 1; i < leaves.length; ++i) {
            bytes32 value = leaves[i];
            uint256 j = i;
            while (j > 0 && leaves[j - 1] > value) {
                leaves[j] = leaves[j - 1];
                --j;
            }
            leaves[j] = value;
        }
        uint256 length = leaves.length;
        while (length > 1) {
            uint256 nextLength = (length + 1) / 2;
            for (uint256 i; i < nextLength; ++i) {
                bytes32 left = leaves[i * 2];
                bytes32 right = i * 2 + 1 < length ? leaves[i * 2 + 1] : left;
                leaves[i] = _hashPair(left, right);
            }
            length = nextLength;
        }
        return leaves[0];
    }

    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }
}
