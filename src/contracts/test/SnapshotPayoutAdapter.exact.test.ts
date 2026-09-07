import { expect } from "chai";
import { ethers, network } from "hardhat";
async function fixture() {
  const [operator, holderA, holderB, stranger] = await ethers.getSigners();
  const hts = await (await ethers.getContractFactory("MockHtsAssociation")).deploy();
  await network.provider.send("hardhat_setCode", ["0x0000000000000000000000000000000000000167", await ethers.provider.getCode(await hts.getAddress())]);
  const token = await (await ethers.getContractFactory("MockAssociationToken")).deploy();
  const asset = await (await ethers.getContractFactory("MockSnapshotAsset")).deploy();
  const adapter = await (await ethers.getContractFactory("SnapshotPayoutAdapter")).deploy(await asset.getAddress(), await token.getAddress(), operator.address);
  await adapter.associatePaymentToken(); await token.mint(await adapter.getAddress(), 2000n);
  await asset.setSnapshot(1n, [holderA.address, holderB.address], [1n, 2n]);
  await token.setAssociated(holderA.address, true); await token.setAssociated(holderB.address, true);
  return { operator, holderA, holderB, stranger, token, asset, adapter, assetAddress: await asset.getAddress() };
}
describe("Exact adapter amount and immutable-total guards", () => {
  it("permits only operator calls, bounds exact amounts and binds the original snapshot total", async () => {
    const f = await fixture();
    await expect(f.adapter.connect(f.stranger).executeExactSnapshotByAddresses(f.assetAddress, 1, [f.holderA.address], 901n, [300n])).to.be.revertedWithCustomError(f.adapter, "Unauthorized");
    await expect(f.adapter.executeExactSnapshotByAddresses(f.stranger.address, 1, [f.holderA.address], 901n, [300n])).to.be.revertedWithCustomError(f.adapter, "InvalidAsset");
    for (const amount of [299n, 302n]) await expect(f.adapter.executeExactSnapshotByAddresses(f.assetAddress, 1, [f.holderA.address], 901n, [amount])).to.be.revertedWithCustomError(f.adapter, "InvalidAmount");
    await expect(f.adapter.executeExactSnapshotByAddresses(f.assetAddress, 1, [f.holderA.address, f.holderA.address], 901n, [300n, 300n])).to.be.revertedWithCustomError(f.adapter, "InvalidAmount");
    expect(await f.token.balanceOf(f.holderA.address)).to.equal(0n);
    await f.adapter.executeExactSnapshotByAddresses(f.assetAddress, 1, [f.holderA.address], 901n, [300n]);
    await expect(f.adapter.executeExactSnapshotByAddresses(f.assetAddress, 1, [f.holderB.address], 902n, [602n])).to.be.revertedWithCustomError(f.adapter, "SnapshotTotalMismatch");
    await f.adapter.executeExactSnapshotByAddresses(f.assetAddress, 1, [f.holderA.address], 901n, [300n]);
    expect(await f.token.balanceOf(f.holderA.address)).to.equal(300n);
    await f.adapter.executeExactSnapshotByAddresses(f.assetAddress, 1, [f.holderB.address], 901n, [601n]);
    expect(await f.adapter.snapshotPaidTotal(1n)).to.equal(901n);
    expect(await f.adapter.snapshotTotal(1n)).to.equal(901n);
  });
  it("never sends a zero token transfer or emits a paid-zero event", async () => {
    const f = await fixture(); await f.token.setAssociated(f.holderA.address, false);
    const resolved = f.adapter.executeExactSnapshotByAddresses(f.assetAddress, 1, [f.holderA.address], 1n, [0n]);
    await expect(resolved).to.emit(f.adapter, "SnapshotHolderNoPaymentDue");
    await expect(resolved).not.to.emit(f.adapter, "SnapshotHolderPaid"); await expect(resolved).not.to.emit(f.token, "Transfer");
    expect(await f.adapter.paid(1, f.holderA.address)).to.equal(true); expect(await f.adapter.snapshotPaidTotal(1n)).to.equal(0n);
  });
  it("retains the legacy floor selector without pretending it is the exact policy", async () => {
    const f = await fixture();
    await f.adapter.executeAmountSnapshotByAddresses(f.assetAddress, 1, [f.holderA.address, f.holderB.address], 901n);
    expect(await f.token.balanceOf(f.holderA.address)).to.equal(300n); expect(await f.token.balanceOf(f.holderB.address)).to.equal(600n);
    expect(await f.adapter.snapshotPaidTotal(1n)).to.equal(900n);
    await expect(f.adapter.executeExactSnapshotByAddresses(f.assetAddress, 1, [f.holderB.address], 902n, [602n])).to.be.revertedWithCustomError(f.adapter, "SnapshotTotalMismatch");
  });
});
