import { expect } from "chai";
import { ethers } from "hardhat";
async function fixture() {
  const [admin, trustee, servicer, holder, outsider] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory("MockPaymentToken")).deploy();
  const asset = await (await ethers.getContractFactory("MockSnapshotAsset")).deploy();
  const registry = await (await ethers.getContractFactory("ReceivablePoolRegistry")).deploy(admin.address);
  const payout = await (await ethers.getContractFactory("MockLifeCycleCashFlow")).deploy(await token.getAddress());
  await payout.setAsset(await asset.getAddress()); await payout.setOperator(await registry.getAddress());
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  const leaves = [1, 2].map(index => ({ schemaVersion: 1, fuIdHash: ethers.id(`FU-${index}`), obligorIdHash: ethers.id(`OBL-${index}`), faceValue: 500n, dueDate: now - 1, acceptedAt: now - 100, currency: "0x494e52", evidenceHash: ethers.id(`evidence-${index}`) }));
  const hashes = await Promise.all(leaves.map(leaf => registry.hashReceivableLeaf(leaf)));
  const poolRoot = ethers.keccak256(ethers.concat([...hashes].sort())); const poolId = ethers.id("exceptions");
  await registry.createPool({ poolId, poolRoot, eligibilityRoot: ethers.id("eligible"), manifestHash: ethers.id("manifest"), assignmentDocumentHash: ethers.id("assignment"), originator: admin.address, trustee: trustee.address, originalFaceValue: 1000n, originalInvestorPrincipal: 980n, totalUnits: 1000n, retainedUnitsAtIssuance: 50n, maturity: now + 1000 });
  await registry.activatePool(poolId, await asset.getAddress(), await payout.getAddress(), await token.getAddress());
  await registry.grantRole(await registry.TRUSTEE_ROLE(), trustee.address); await registry.grantRole(await registry.SERVICER_ROLE(), servicer.address); await registry.grantRole(await registry.PAYOUT_EXECUTOR_ROLE(), servicer.address);
  await token.mint(await payout.getAddress(), 100n);
  await registry.connect(servicer).recordCollection(poolId, ethers.id("cash"), ethers.id("cash-payload"), 100n, leaves[0]!, [hashes[1]!]);
  await asset.setSnapshot(1n, [holder.address], [1000n]);
  const distributionId = ethers.id("reserved-distribution");
  const entitlement = { holder: holder.address, snapshotBalance: 1000n, cashAmount: 80n, principalAmount: 80n, incomeAmount: 0n };
  await registry.connect(trustee).approveDistribution(poolId, distributionId, 1n, 80n, 0n, [entitlement]);
  const decision = ethers.id("Trustee approved after reviewing the evidence");
  return { registry, token, trustee, servicer, holder, outsider, leaves, hashes, poolId, distributionId, entitlement, decision };
}
describe("Exceptional write-off, principal loss and prepayment cancellation", () => {
  it("writes off defaulted face separately, caps principal write-down and blocks ordinary post-writeoff receipts", async () => {
    const { registry, trustee, servicer, outsider, leaves, hashes, poolId, decision } = await fixture();
    const source = ethers.id("write-off"), payload = ethers.id("write-off-payload");
    await expect(registry.connect(trustee).writeOffReceivable(poolId, source, payload, decision, leaves[0]!, [hashes[1]!])).to.be.revertedWithCustomError(registry, "InvalidState");
    for (let index = 0; index < 2; index++) {
      await registry.connect(servicer).markDelinquent(poolId, ethers.id(`late-${index}`), ethers.id(`late-payload-${index}`), leaves[index]!, [hashes[1 - index]!]);
      await registry.connect(trustee).markDefault(poolId, ethers.id(`default-${index}`), ethers.id(`default-payload-${index}`), 200n, leaves[index]!, [hashes[1 - index]!]);
    }
    await expect(registry.connect(outsider).writeOffReceivable(poolId, source, payload, decision, leaves[0]!, [hashes[1]!])).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    await registry.connect(trustee).writeOffReceivable(poolId, source, payload, decision, leaves[0]!, [hashes[1]!]);
    let pool = await registry.getPool(poolId);
    expect(pool.defaultedFaceOutstanding).to.equal(500n); expect(pool.estimatedDefaultRecoveries).to.equal(200n); expect(pool.realizedLosses).to.equal(400n); expect(pool.investorPrincipalOutstanding).to.equal(980n);
    expect(await registry.collectedByReceivable(poolId, leaves[0]!.fuIdHash)).to.equal(100n); expect(await registry.writtenOffByReceivable(poolId, leaves[0]!.fuIdHash)).to.equal(400n);
    await expect(registry.connect(trustee).writeOffReceivable(poolId, source, payload, decision, leaves[0]!, [hashes[1]!])).to.emit(registry, "ServicingReplayIgnored");
    await expect(registry.connect(trustee).writeOffReceivable(poolId, source, payload, ethers.id("changed"), leaves[0]!, [hashes[1]!])).to.be.revertedWithCustomError(registry, "ConflictingServicingEvent");
    await expect(registry.connect(servicer).recordCollection(poolId, ethers.id("late-cash"), ethers.id("late-cash-payload"), 1n, leaves[0]!, [hashes[1]!])).to.be.revertedWithCustomError(registry, "InvalidState");
    await registry.connect(trustee).writeDownPrincipal(poolId, ethers.id("principal-1"), ethers.id("principal-payload-1"), 300n, decision);
    await expect(registry.connect(trustee).writeDownPrincipal(poolId, ethers.id("principal-2"), ethers.id("principal-payload-2"), 101n, decision)).to.be.revertedWithCustomError(registry, "InvalidAmount");
    await registry.connect(trustee).writeOffReceivable(poolId, ethers.id("write-off-2"), ethers.id("write-off-payload-2"), decision, leaves[1]!, [hashes[0]!]);
    await expect(registry.connect(trustee).writeDownPrincipal(poolId, ethers.id("principal-3"), ethers.id("principal-payload-3"), 601n, decision)).to.be.revertedWithCustomError(registry, "InvalidAmount");
    await registry.connect(trustee).writeDownPrincipal(poolId, ethers.id("principal-3"), ethers.id("principal-payload-3"), 600n, decision);
    pool = await registry.getPool(poolId); expect(pool.realizedLosses).to.equal(900n); expect(pool.investorPrincipalOutstanding).to.equal(80n); expect(pool.reservedPrincipal).to.equal(80n); expect(pool.availableCash).to.equal(20n); expect(await registry.totalPrincipalWrittenDown(poolId)).to.equal(900n);
    await expect(registry.connect(trustee).writeDownPrincipal(poolId, ethers.id("principal-3"), ethers.id("principal-payload-3"), 600n, decision)).to.emit(registry, "ServicingReplayIgnored");
    await expect(registry.connect(trustee).writeDownPrincipal(poolId, ethers.id("principal-3"), ethers.id("principal-payload-3"), 599n, decision)).to.be.revertedWithCustomError(registry, "ConflictingServicingEvent");
  });
  it("cancels before payment exactly once, releases reservations and retains immutable snapshot binding", async () => {
    const { registry, trustee, servicer, poolId, distributionId, entitlement, decision } = await fixture();
    const source = ethers.id("cancel"), payload = ethers.id("cancel-payload");
    await registry.connect(trustee).cancelDistribution(distributionId, source, payload, decision);
    const pool = await registry.getPool(poolId); expect(pool.availableCash).to.equal(100n); expect(pool.reservedCash).to.equal(0n); expect(pool.reservedPrincipal).to.equal(0n); expect(pool.investorPrincipalOutstanding).to.equal(980n); expect(await registry.pendingDistributions(poolId)).to.equal(0n);
    const distribution = await registry.getDistribution(distributionId); expect(distribution.status).to.equal(5n); expect(distribution.snapshotId).to.equal(1n); expect(distribution.immutablePayoutTotal).to.equal(80n);
    await expect(registry.connect(trustee).cancelDistribution(distributionId, source, payload, decision)).to.emit(registry, "ServicingReplayIgnored");
    await expect(registry.connect(trustee).cancelDistribution(distributionId, source, payload, ethers.id("changed"))).to.be.revertedWithCustomError(registry, "ConflictingServicingEvent");
    await expect(registry.connect(servicer).executeDistributionBatch(distributionId, [entitlement], [[]])).to.be.revertedWithCustomError(registry, "DistributionNotPayable");
  });
  it("rejects cancellation after any successful payout", async () => {
    const { registry, trustee, servicer, poolId, distributionId, entitlement, decision } = await fixture();
    await registry.connect(servicer).executeDistributionBatch(distributionId, [entitlement], [[]]);
    await expect(registry.connect(trustee).cancelDistribution(distributionId, ethers.id("late-cancel"), ethers.id("late-payload"), decision)).to.be.revertedWithCustomError(registry, "DistributionNotPayable");
    expect(await registry.pendingDistributions(poolId)).to.equal(1n);
  });
});
