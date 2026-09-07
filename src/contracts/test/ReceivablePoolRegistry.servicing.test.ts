import { expect } from "chai";
import { ethers } from "hardhat";

async function fixture() {
  const [admin, servicer, trustee, outsider] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory("MockPaymentToken")).deploy();
  const asset = await (await ethers.getContractFactory("MockSnapshotAsset")).deploy();
  const payout = await (await ethers.getContractFactory("MockLifeCycleCashFlow")).deploy(await token.getAddress());
  const registry = await (await ethers.getContractFactory("ReceivablePoolRegistry")).deploy(admin.address);
  await payout.setOperator(await registry.getAddress()); await payout.setAsset(await asset.getAddress());
  const dueDate = (await ethers.provider.getBlock("latest"))!.timestamp + 1000;
  const leaf = { schemaVersion: 1, fuIdHash: ethers.id("FU-001"), obligorIdHash: ethers.id("O-001"), faceValue: 1000n, dueDate, currency: "0x494e52", acceptedAt: dueDate - 10000, evidenceHash: ethers.id("evidence") };
  const poolId = ethers.id("SERVICING");
  await registry.createPool({ poolId, poolRoot: await registry.hashReceivableLeaf(leaf), eligibilityRoot: ethers.id("eligible"), manifestHash: ethers.id("manifest"), assignmentDocumentHash: ethers.id("assignment"), originator: admin.address, trustee: trustee.address, originalFaceValue: 1000n, originalInvestorPrincipal: 980n, totalUnits: 1000n, retainedUnitsAtIssuance: 50n, maturity: dueDate + 10000 });
  await registry.activatePool(poolId, await asset.getAddress(), await payout.getAddress(), await token.getAddress());
  await registry.grantRole(await registry.SERVICER_ROLE(), servicer.address);
  await registry.grantRole(await registry.TRUSTEE_ROLE(), trustee.address);
  await token.mint(await payout.getAddress(), 1000n);
  const args = (ref: string) => [poolId, ethers.id(ref), ethers.id(`payload:${ref}`)] as const;
  return { registry, servicer, trustee, outsider, leaf, poolId, args };
}

describe("Servicing transitions and recovery economics", () => {
  it("requires actual due time and dedicated roles, without consuming rejected sources", async () => {
    const { registry, servicer, outsider, leaf, poolId, args } = await fixture();
    await expect(registry.connect(servicer).markDelinquent(...args("late"), leaf, [])).to.be.revertedWithCustomError(registry, "ReceivableNotDue");
    expect(await registry.servicingPayloadHash(ethers.id("late"))).to.equal(ethers.ZeroHash);
    await ethers.provider.send("evm_setNextBlockTimestamp", [leaf.dueDate + 1]);
    await expect(registry.connect(outsider).markDelinquent(...args("late"), leaf, [])).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    await registry.connect(servicer).markDelinquent(...args("late"), leaf, []);
    await expect(registry.connect(servicer).markDefault(...args("default"), 400n, leaf, [])).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    expect((await registry.getPool(poolId)).investorPrincipalOutstanding).to.equal(980n);
  });
  it("collects from each bucket, revises recovery up/down, cures, and preserves principal and realized loss", async () => {
    const { registry, servicer, trustee, leaf, poolId, args } = await fixture();
    await registry.connect(servicer).recordCollection(...args("performing-cash"), 100n, leaf, []);
    await ethers.provider.send("evm_setNextBlockTimestamp", [leaf.dueDate + 1]);
    await registry.connect(servicer).markDelinquent(...args("late"), leaf, []);
    await registry.connect(servicer).recordCollection(...args("delinquent-cash"), 100n, leaf, []);
    await registry.connect(trustee).markDefault(...args("default"), 400n, leaf, []);
    await registry.connect(trustee).reviseRecoveryEstimate(...args("raise"), 600n, leaf, []);
    await expect(registry.connect(trustee).reviseRecoveryEstimate(...args("raise"), 601n, leaf, [])).to.be.revertedWithCustomError(registry, "ConflictingServicingEvent");
    await expect(registry.connect(trustee).reviseRecoveryEstimate(...args("raise"), 600n, leaf, [])).to.emit(registry, "ServicingReplayIgnored");
    await expect(registry.connect(trustee).reviseRecoveryEstimate(...args("excess"), 801n, leaf, [])).to.be.revertedWithCustomError(registry, "InvalidAmount");
    await registry.connect(trustee).reviseRecoveryEstimate(...args("reduce"), 200n, leaf, []);
    await registry.connect(servicer).recordCollection(...args("recovery-cash"), 300n, leaf, []);
    let pool = await registry.getPool(poolId);
    expect(pool.defaultedFaceOutstanding).to.equal(500n);
    expect(pool.estimatedDefaultRecoveries).to.equal(0n);
    expect(pool.availableCash).to.equal(500n);
    await registry.connect(trustee).cureReceivable(...args("cure"), leaf, []);
    await expect(registry.connect(trustee).cureReceivable(...args("cure"), leaf, [])).to.emit(registry, "ServicingReplayIgnored");
    pool = await registry.getPool(poolId);
    expect(pool.performingFaceOutstanding).to.equal(500n);
    expect(pool.defaultedFaceOutstanding).to.equal(0n);
    expect(pool.investorPrincipalOutstanding).to.equal(980n);
    expect(pool.realizedLosses).to.equal(0n);
    await expect(registry.connect(trustee).reviseRecoveryEstimate(...args("after-cure"), 10n, leaf, [])).to.be.revertedWithCustomError(registry, "InvalidState");
    await registry.connect(servicer).recordCollection(...args("paid"), 500n, leaf, []);
    expect(await registry.receivableStatus(poolId, leaf.fuIdHash)).to.equal(5n);
  });
});
