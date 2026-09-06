// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.22;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAtSnapshot, ILifeCycleCashFlow, IExactSnapshotPayout} from "../interfaces/IReceivableXExternal.sol";

contract MockLifeCycleCashFlow is ILifeCycleCashFlow, IExactSnapshotPayout {
    IERC20 public immutable paymentToken;
    address public operator;
    address public asset;
    mapping(uint256 => mapping(address => bool)) public paid;

    constructor(address paymentToken_) { paymentToken = IERC20(paymentToken_); }
    function setOperator(address operator_) external { operator = operator_; }
    function setAsset(address asset_) external { asset = asset_; }
    function exactPayoutVersion() external pure returns (uint256) { return 1; }
    function executeExactSnapshotByAddresses(address asset_, uint256 snapshotId, address[] calldata holders, uint256, uint256[] calldata amounts)
        external returns (address[] memory failed, address[] memory succeeded, uint256[] memory paidAmount)
    {
        require(msg.sender == operator && asset_ == asset && holders.length == amounts.length, "binding");
        failed = new address[](holders.length); succeeded = new address[](holders.length); paidAmount = new uint256[](holders.length);
        for (uint256 i; i < holders.length; ++i) {
            if (paid[snapshotId][holders[i]] || (amounts[i] > 0 && !paymentToken.transfer(holders[i], amounts[i]))) { failed[i] = holders[i]; continue; }
            paid[snapshotId][holders[i]] = true; succeeded[i] = holders[i]; paidAmount[i] = amounts[i];
        }
    }

    function executeAmountSnapshotByAddresses(
        address asset_,
        uint256 snapshotId,
        address[] calldata holders,
        uint256 amount
    ) external returns (address[] memory failed, address[] memory succeeded, uint256[] memory paidAmount) {
        require(msg.sender == operator, "operator");
        failed = new address[](holders.length);
        succeeded = new address[](holders.length);
        paidAmount = new uint256[](holders.length);
        require(asset_ == asset, "asset");
        uint256 supply = IAtSnapshot(asset_).totalSupplyAtSnapshot(snapshotId);
        for (uint256 i; i < holders.length; ++i) {
            address holder = holders[i];
            uint256 entitlement = amount * IAtSnapshot(asset_).balanceOfAtSnapshot(snapshotId, holder) / supply;
            if (paid[snapshotId][holder] || !paymentToken.transfer(holder, entitlement)) {
                failed[i] = holder;
                continue;
            }
            paid[snapshotId][holder] = true;
            succeeded[i] = holder;
            paidAmount[i] = entitlement;
        }
    }
}

/// @dev Binding-shaped legacy deployment without the exact payout capability.
contract MockLegacyPayoutBinding {
    address public immutable asset;
    address public immutable paymentToken;
    address public immutable operator;
    constructor(address asset_, address token_, address operator_) { asset = asset_; paymentToken = token_; operator = operator_; }
}
