// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.22;

import {HederaTokenService} from "@hashgraph/smart-contracts/contracts/system-contracts/hedera-token-service/HederaTokenService.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAtSnapshot, ILifeCycleCashFlow, IExactSnapshotPayout} from "./interfaces/IReceivableXExternal.sol";

/// @notice Minimal testnet adapter for proving fixed-amount ATS snapshot payouts with an HTS token.
/// @dev Replace with pinned LifeCycleCashFlow after its full deployment stack is integrated.
contract SnapshotPayoutAdapter is HederaTokenService, ILifeCycleCashFlow, IExactSnapshotPayout {
    using SafeERC20 for IERC20;

    address public immutable asset;
    address public immutable paymentToken;
    address public immutable operator;
    bool public associated;
    mapping(uint256 => mapping(address => bool)) public paid;
    mapping(uint256 => uint256) public snapshotTotal;
    mapping(uint256 => bool) public snapshotTotalBound;
    mapping(uint256 => uint256) public snapshotPaidTotal;

    error Unauthorized();
    error InvalidAsset();
    error InvalidAddress();
    error AssociationFailed(int64 responseCode);
    error NotAssociated();
    error InvalidAmount();
    error SnapshotTotalMismatch();

    event PaymentTokenAssociated(address indexed token);
    event SnapshotHolderPaid(uint256 indexed snapshotId, address indexed holder, uint256 amount);
    event SnapshotHolderNoPaymentDue(uint256 indexed snapshotId, address indexed holder);

    modifier onlyOperator() {
        if (msg.sender != operator) revert Unauthorized();
        _;
    }

    constructor(address asset_, address paymentToken_, address operator_) {
        if (asset_ == address(0) || paymentToken_ == address(0) || operator_ == address(0)) revert InvalidAddress();
        asset = asset_;
        paymentToken = paymentToken_;
        operator = operator_;
    }

    function associatePaymentToken() external onlyOperator {
        if (associated) return;
        int64 responseCode = int64(associateToken(address(this), paymentToken));
        if (responseCode != 22) revert AssociationFailed(responseCode);
        associated = true;
        emit PaymentTokenAssociated(paymentToken);
    }
    function exactPayoutVersion() external pure returns (uint256) { return 1; }

    function _bindTotal(uint256 snapshotId, uint256 total) private {
        if (total == 0) revert InvalidAmount();
        if (snapshotTotalBound[snapshotId] && snapshotTotal[snapshotId] != total) revert SnapshotTotalMismatch();
        snapshotTotalBound[snapshotId] = true;
        snapshotTotal[snapshotId] = total;
    }

    function _pay(uint256 snapshotId, address holder, uint256 amount) private {
        if (holder == address(0) || amount > snapshotTotal[snapshotId] - snapshotPaidTotal[snapshotId]) revert InvalidAmount();
        paid[snapshotId][holder] = true;
        snapshotPaidTotal[snapshotId] += amount;
        if (amount == 0) emit SnapshotHolderNoPaymentDue(snapshotId, holder);
        else {
            IERC20(paymentToken).safeTransfer(holder, amount);
            emit SnapshotHolderPaid(snapshotId, holder, amount);
        }
    }

    function executeAmountSnapshotByAddresses(
        address asset_,
        uint256 snapshotId,
        address[] calldata holders,
        uint256 amount
    ) external onlyOperator returns (address[] memory failed, address[] memory succeeded, uint256[] memory paidAmount) {
        if (!associated) revert NotAssociated();
        if (asset_ != asset) revert InvalidAsset();
        failed = new address[](holders.length);
        succeeded = new address[](holders.length);
        paidAmount = new uint256[](holders.length);
        uint256 supply = IAtSnapshot(asset).totalSupplyAtSnapshot(snapshotId);
        if (supply == 0) revert InvalidAmount();
        _bindTotal(snapshotId, amount);
        for (uint256 i; i < holders.length; ++i) {
            address holder = holders[i];
            uint256 entitlement = Math.mulDiv(amount, IAtSnapshot(asset).balanceOfAtSnapshot(snapshotId, holder), supply);
            if (paid[snapshotId][holder]) {
                failed[i] = holder;
                continue;
            }
            _pay(snapshotId, holder, entitlement);
            succeeded[i] = holder;
            paidAmount[i] = entitlement;
        }
    }

    /// @notice Pays Registry-committed exact entitlements. Bounds alone do not define
    /// largest-remainder winners; the Registry verifies the complete plan first.
    function executeExactSnapshotByAddresses(address asset_, uint256 snapshotId, address[] calldata holders, uint256 immutableTotal, uint256[] calldata amounts)
        external onlyOperator returns (address[] memory failed, address[] memory succeeded, uint256[] memory paidAmount)
    {
        if (!associated) revert NotAssociated();
        if (asset_ != asset) revert InvalidAsset();
        if (holders.length == 0 || holders.length != amounts.length) revert InvalidAmount();
        uint256 supply = IAtSnapshot(asset).totalSupplyAtSnapshot(snapshotId);
        if (supply == 0) revert InvalidAmount();
        _bindTotal(snapshotId, immutableTotal);
        failed = new address[](holders.length); succeeded = new address[](holders.length); paidAmount = new uint256[](holders.length);
        for (uint256 i; i < holders.length; ++i) {
            for (uint256 j; j < i; ++j) if (holders[i] == holders[j]) revert InvalidAmount();
            uint256 balance = IAtSnapshot(asset).balanceOfAtSnapshot(snapshotId, holders[i]);
            uint256 floor = Math.mulDiv(immutableTotal, balance, supply);
            uint256 ceiling = floor + (mulmod(immutableTotal, balance, supply) == 0 ? 0 : 1);
            if (amounts[i] < floor || amounts[i] > ceiling) revert InvalidAmount();
            if (paid[snapshotId][holders[i]]) { failed[i] = holders[i]; continue; }
            _pay(snapshotId, holders[i], amounts[i]);
            succeeded[i] = holders[i]; paidAmount[i] = amounts[i];
        }
    }
}
