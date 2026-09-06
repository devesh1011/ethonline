// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.22;

interface IAssociationTestToken {
    function setAssociated(address account, bool value) external;
}

/// @dev Install this runtime code at 0x167 on Hardhat only. Models adapter
/// association success, not native Hedera balances, fees, or response records.
contract MockHtsAssociation {
    function associateToken(address account, address token) external returns (int64) {
        IAssociationTestToken(token).setAssociated(account, true);
        return 22;
    }
}
