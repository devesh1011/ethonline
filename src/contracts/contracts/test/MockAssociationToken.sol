// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.22;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Local-only payment model. Does not claim to reproduce HTS consensus.
contract MockAssociationToken is ERC20 {
    mapping(address => bool) public associated;
    mapping(address => bool) public blocked;
    error RecipientUnassociated(address recipient);
    error RecipientBlocked(address recipient);

    constructor() ERC20("Local association payment token", "LAPT") {}
    function mint(address account, uint256 amount) external { _mint(account, amount); }
    function setAssociated(address account, bool value) external { associated[account] = value; }
    function setBlocked(address account, bool value) external { blocked[account] = value; }
    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0)) {
            if (!associated[to]) revert RecipientUnassociated(to);
            if (blocked[to]) revert RecipientBlocked(to);
        }
        super._update(from, to, amount);
    }
}
