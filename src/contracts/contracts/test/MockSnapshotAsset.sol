// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.22;

import {IAtSnapshot} from "../interfaces/IReceivableXExternal.sol";

contract MockSnapshotAsset is IAtSnapshot {
    mapping(uint256 => mapping(address => uint256)) private balances;
    mapping(uint256 => uint256) private supplies;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    function setBalance(address holder, uint256 amount) external {
        totalSupply = totalSupply - balanceOf[holder] + amount;
        balanceOf[holder] = amount;
    }
    function retire(uint256 amount) external {
        require(amount > 0 && amount <= balanceOf[msg.sender], "balance");
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
    }

    function setSnapshot(uint256 snapshotId, address[] calldata holders, uint256[] calldata amounts) external {
        require(holders.length == amounts.length, "length");
        uint256 total;
        for (uint256 i; i < holders.length; ++i) {
            balances[snapshotId][holders[i]] = amounts[i];
            total += amounts[i];
        }
        supplies[snapshotId] = total;
    }

    function balanceOfAtSnapshot(uint256 snapshotId, address account) external view returns (uint256) {
        return balances[snapshotId][account];
    }

    function totalSupplyAtSnapshot(uint256 snapshotId) external view returns (uint256) {
        return supplies[snapshotId];
    }
}
