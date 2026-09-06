// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.22;

interface IAtSnapshot {
    function totalSupply() external view returns (uint256);
    function balanceOfAtSnapshot(uint256 snapshotId, address account) external view returns (uint256);
    function totalSupplyAtSnapshot(uint256 snapshotId) external view returns (uint256);
}

interface ILifeCycleCashFlow {
    function executeAmountSnapshotByAddresses(
        address asset,
        uint256 snapshotId,
        address[] calldata holders,
        uint256 amount
    ) external returns (address[] memory failed, address[] memory succeeded, uint256[] memory paidAmount);
}

interface IAssociablePayout {
    function associatePaymentToken() external;
}

/// @notice ReceivableX exact entitlement extension; not an official Mass Payout selector.
interface IExactSnapshotPayout {
    function exactPayoutVersion() external view returns (uint256);
    function executeExactSnapshotByAddresses(address asset, uint256 snapshotId, address[] calldata holders, uint256 immutableTotal, uint256[] calldata amounts)
        external returns (address[] memory failed, address[] memory succeeded, uint256[] memory paidAmount);
}

interface IPayoutBinding {
    function asset() external view returns (address);
    function paymentToken() external view returns (address);
    function operator() external view returns (address);
}
