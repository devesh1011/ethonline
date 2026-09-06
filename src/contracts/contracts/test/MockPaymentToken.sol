// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.22;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockPaymentToken is ERC20 {
    constructor() ERC20("Mock INRx", "mINRX") {}
    function mint(address account, uint256 amount) external { _mint(account, amount); }
}
