import { expect } from "chai";
import { ethers } from "hardhat";

async function fixture() {
  const [admin, other] = await ethers.getSigners();
  const registry = await (await ethers.getContractFactory("ReceivablePoolRegistry")).deploy(admin.address);
  const token = await (await ethers.getContractFactory("MockPaymentToken")).deploy();
  const asset = await (await ethers.getContractFactory("MockSnapshotAsset")).deploy();
  const adapter = await (await ethers.getContractFactory("SnapshotPayoutAdapter")).deploy(
    await asset.getAddress(), await token.getAddress(), await registry.getAddress(),
  );
  const poolId = ethers.id("ISOLATED-POOL");
  const secondId = ethers.id("SECOND-POOL");
  const leaf = { schemaVersion: 1, fuIdHash: ethers.id("FU"), obligorIdHash: ethers.id("OBLIGOR"),
    faceValue: 1000n, dueDate: 2000000000, currency: "0x494e52", acceptedAt: 1700000000, evidenceHash: ethers.id("EVIDENCE") };
  for (const id of [poolId, secondId]) await registry.createPool({ poolId: id,
    poolRoot: await registry.hashReceivableLeaf(leaf), eligibilityRoot: ethers.id("ELIGIBLE"),
    manifestHash: ethers.id("MANIFEST"), assignmentDocumentHash: ethers.id("ASSIGNMENT"),
    originator: other.address, trustee: admin.address, originalFaceValue: 1000n,
    originalInvestorPrincipal: 980n, totalUnits: 1000n, retainedUnitsAtIssuance: 50n, maturity: 2000000000 });
  return { admin, other, registry, token, asset, adapter, poolId, secondId, leaf };
}

describe("ReceivablePoolRegistry pool isolation", () => {
  it("validates the real adapter asset, payment token and operator before activation", async () => {
    const { registry, asset, token, adapter, poolId, other } = await fixture();
    const activate = (assetAddress: string, payout: string, payment: string) => registry.activatePool(poolId, assetAddress, payout, payment);
    for (const args of [
      [other.address, await adapter.getAddress(), await token.getAddress()],
      [await asset.getAddress(), other.address, await token.getAddress()],
      [await asset.getAddress(), await adapter.getAddress(), other.address],
    ]) await expect(activate(args[0], args[1], args[2])).to.be.revertedWithCustomError(registry, "InvalidPayoutBinding");
    const wrongOperator = await (await ethers.getContractFactory("SnapshotPayoutAdapter")).deploy(
      await asset.getAddress(), await token.getAddress(), other.address,
    );
    const otherAsset = await (await ethers.getContractFactory("MockSnapshotAsset")).deploy();
    await expect(activate(await asset.getAddress(), await wrongOperator.getAddress(), await token.getAddress()))
      .to.be.revertedWithCustomError(registry, "InvalidPayoutBinding");
    await expect(activate(await otherAsset.getAddress(), await adapter.getAddress(), await token.getAddress()))
      .to.be.revertedWithCustomError(registry, "InvalidPayoutBinding");
    expect(await registry.activePoolId()).to.equal(ethers.ZeroHash);
    expect((await registry.getPool(poolId)).status).to.equal(0n);
    await expect(activate(await asset.getAddress(), await adapter.getAddress(), await token.getAddress()))
      .to.emit(registry, "PoolActivated");
    expect(await registry.activePoolId()).to.equal(poolId);
  });

  it("rejects a second pool even with separate valid custody and prevents cash double counting", async () => {
    const { registry, asset, token, adapter, poolId, secondId, leaf, admin } = await fixture();
    await registry.activatePool(poolId, await asset.getAddress(), await adapter.getAddress(), await token.getAddress());
    await expect(registry.activatePool(secondId, await asset.getAddress(), await adapter.getAddress(), await token.getAddress()))
      .to.be.revertedWithCustomError(registry, "ActivePoolAlreadyExists");
    const separate = await (await ethers.getContractFactory("SnapshotPayoutAdapter")).deploy(
      await asset.getAddress(), await token.getAddress(), await registry.getAddress(),
    );
    await expect(registry.activatePool(secondId, await asset.getAddress(), await separate.getAddress(), await token.getAddress()))
      .to.be.revertedWithCustomError(registry, "ActivePoolAlreadyExists");
    await token.mint(await adapter.getAddress(), 100n);
    await registry.grantRole(await registry.SERVICER_ROLE(), admin.address);
    await registry.recordCollection(poolId, ethers.id("FIRST"), ethers.id("PAYLOAD"), 100n, leaf, []);
    await expect(registry.recordCollection(secondId, ethers.id("SECOND"), ethers.id("PAYLOAD"), 100n, leaf, []))
      .to.be.revertedWithCustomError(registry, "InvalidState");
    await expect(registry.recordCollection(poolId, ethers.id("SECOND"), ethers.id("PAYLOAD"), 100n, leaf, []))
      .to.be.revertedWithCustomError(registry, "InsufficientCashCoverage");
    expect((await registry.getPool(poolId)).availableCash).to.equal(100n);
    expect((await registry.getPool(secondId)).availableCash).to.equal(0n);
    expect(await token.balanceOf(await adapter.getAddress())).to.equal(100n);
    await asset.setSnapshot(1n, [admin.address], [1000n]);
    await registry.grantRole(await registry.TRUSTEE_ROLE(), admin.address);
    const entitlements = [{ holder: admin.address, snapshotBalance: 1000n, cashAmount: 50n, principalAmount: 50n, incomeAmount: 0n }];
    await registry.approveDistribution(poolId, ethers.id("DIST-1"), 1n, 50n, 0n, entitlements);
    expect(await registry.snapshotBound(await adapter.getAddress(), 1n)).to.equal(true);
    await expect(registry.approveDistribution(poolId, ethers.id("DIST-2"), 1n, 50n, 0n, entitlements))
      .to.be.revertedWithCustomError(registry, "SnapshotAlreadyBound");
    expect((await registry.getPool(poolId)).availableCash).to.equal(50n);
    expect((await registry.getPool(poolId)).reservedCash).to.equal(50n);
  });
});
