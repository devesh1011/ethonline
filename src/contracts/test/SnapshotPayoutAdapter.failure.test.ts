import { expect } from "chai";
import { ethers, network } from "hardhat";

async function fixture() {
  const [admin, ...accounts] = await ethers.getSigners();
  const holders = accounts.slice(0, 2).sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
  const [first, later] = holders;
  const hts = await (await ethers.getContractFactory("MockHtsAssociation")).deploy();
  await network.provider.send("hardhat_setCode", ["0x0000000000000000000000000000000000000167", await ethers.provider.getCode(await hts.getAddress())]);
  const token = await (await ethers.getContractFactory("MockAssociationToken")).deploy();
  const asset = await (await ethers.getContractFactory("MockSnapshotAsset")).deploy();
  const registry = await (await ethers.getContractFactory("ReceivablePoolRegistry")).deploy(admin.address);
  const adapter = await (await ethers.getContractFactory("SnapshotPayoutAdapter")).deploy(await asset.getAddress(), await token.getAddress(), await registry.getAddress());
  const poolId = ethers.id("actual-adapter-pool"), distributionId = ethers.id("actual-adapter-distribution");
  const leaf = { schemaVersion: 1, fuIdHash: ethers.id("FU-001"), obligorIdHash: ethers.id("OBLIGOR"), faceValue: 100n, dueDate: 2_000_000_000, currency: "0x494e52", acceptedAt: 1_700_000_000, evidenceHash: ethers.id("evidence") };
  await registry.createPool({ poolId, poolRoot: await registry.hashReceivableLeaf(leaf), eligibilityRoot: ethers.id("eligibility"), manifestHash: ethers.id("manifest"), assignmentDocumentHash: ethers.id("assignment"), originator: admin.address, trustee: admin.address, originalFaceValue: 100n, originalInvestorPrincipal: 80n, totalUnits: 3n, retainedUnitsAtIssuance: 1n, maturity: 2_000_000_000 });
  await registry.activatePool(poolId, await asset.getAddress(), await adapter.getAddress(), await token.getAddress());
  await registry.initializePayoutAdapter(poolId);
  expect(await adapter.associated()).to.equal(true);
  expect(await token.associated(await adapter.getAddress())).to.equal(true);
  await registry.grantRole(await registry.SERVICER_ROLE(), admin.address);
  await registry.grantRole(await registry.TRUSTEE_ROLE(), admin.address);
  await registry.grantRole(await registry.PAYOUT_EXECUTOR_ROLE(), admin.address);
  await token.mint(await adapter.getAddress(), 100n);
  await registry.recordCollection(poolId, ethers.id("collection"), ethers.id("payload"), 100n, leaf, []);
  await asset.setBalance(first.address, 1n); await asset.setBalance(later.address, 2n);
  await asset.setSnapshot(7n, [first.address, later.address], [1n, 2n]);
  const entries = [
    { holder: first.address, snapshotBalance: 1n, cashAmount: 33n, principalAmount: 27n, incomeAmount: 6n },
    { holder: later.address, snapshotBalance: 2n, cashAmount: 67n, principalAmount: 53n, incomeAmount: 14n },
  ];
  await registry.approveDistribution(poolId, distributionId, 7n, 80n, 20n, entries);
  const leaves = await Promise.all(entries.map(entry => registry.hashEntitlement(entry)));
  const proofs = [[leaves[1]], [leaves[0]]];
  await token.setAssociated(first.address, true); await token.setAssociated(later.address, true);
  return { token, asset, registry, adapter, poolId, distributionId, first, later, entries, proofs };
}

describe("Actual SnapshotPayoutAdapter recipient failures (local HTS association stub)", () => {
  for (const failure of ["blocked", "unassociated"] as const) {
    it(`keeps a ${failure} first holder unresolved, pays exact later entitlement and retries only first`, async () => {
      const f = await fixture();
      if (failure === "blocked") await f.token.setBlocked(f.first.address, true);
      else await f.token.setAssociated(f.first.address, false);
      const committed = await f.registry.getDistribution(f.distributionId);
      await expect(f.registry.executeDistributionBatch(f.distributionId, [f.entries[0]], [f.proofs[0]]))
        .to.be.revertedWithCustomError(f.token, failure === "blocked" ? "RecipientBlocked" : "RecipientUnassociated");
      expect(await f.adapter.paid(7n, f.first.address)).to.equal(false);
      expect(await f.registry.holderPaid(f.distributionId, f.first.address)).to.equal(false);
      await f.registry.executeDistributionBatch(f.distributionId, [f.entries[1]], [f.proofs[1]]);
      expect(await f.token.balanceOf(f.later.address)).to.equal(67n);
      expect(await f.token.balanceOf(f.first.address)).to.equal(0n);
      await expect(f.registry.executeDistributionBatch(f.distributionId, [f.entries[1]], [f.proofs[1]]))
        .to.be.revertedWithCustomError(f.registry, "PayoutResultInvalid");
      let pool = await f.registry.getPool(f.poolId);
      expect(pool.reservedCash).to.equal(33n);
      expect(pool.reservedPrincipal).to.equal(27n);
      expect(pool.investorPrincipalOutstanding).to.equal(27n);
      await expect(f.registry.finalizeDistribution(f.distributionId)).to.be.revertedWithCustomError(f.registry, "DistributionNotPayable");

      if (failure === "blocked") await f.token.setBlocked(f.first.address, false);
      else await f.token.setAssociated(f.first.address, true);
      await f.registry.executeDistributionBatch(f.distributionId, [f.entries[0]], [f.proofs[0]]);
      expect(await f.token.balanceOf(f.first.address)).to.equal(33n);
      expect(await f.token.balanceOf(f.later.address)).to.equal(67n);
      await expect(f.registry.executeDistributionBatch(f.distributionId, [f.entries[0]], [f.proofs[0]]))
        .to.be.revertedWithCustomError(f.registry, "DistributionNotPayable");
      const paid = await f.registry.getDistribution(f.distributionId);
      expect(paid.entitlementRoot).to.equal(committed.entitlementRoot);
      expect(paid.snapshotId).to.equal(7n);
      expect(paid.immutablePayoutTotal).to.equal(100n);
      expect(paid.principalBudget).to.equal(80n); expect(paid.incomeBudget).to.equal(20n);
      expect(paid.cashPaid).to.equal(100n); expect(paid.paidCount).to.equal(2n);
      pool = await f.registry.getPool(f.poolId);
      expect(pool.reservedCash).to.equal(0n);
      expect(pool.availableCash).to.equal(0n);
      await f.registry.finalizeDistribution(f.distributionId);
      pool = await f.registry.getPool(f.poolId);
      expect(pool.reservedCash).to.equal(0n); expect(pool.availableCash).to.equal(0n);
      expect(pool.reservedPrincipal).to.equal(0n); expect(pool.investorPrincipalOutstanding).to.equal(0n);
    });
  }
  it("demonstrates multi-holder rollback, making one-holder envelopes mandatory", async () => {
    const f = await fixture();
    await f.token.setBlocked(f.first.address, true);
    await expect(f.registry.executeDistributionBatch(f.distributionId, [f.entries[1], f.entries[0]], [f.proofs[1], f.proofs[0]]))
      .to.be.revertedWithCustomError(f.token, "RecipientBlocked");
    expect(await f.token.balanceOf(f.later.address)).to.equal(0n);
    expect(await f.adapter.paid(7n, f.later.address)).to.equal(false);
    expect((await f.registry.getPool(f.poolId)).reservedCash).to.equal(100n);
  });
});
