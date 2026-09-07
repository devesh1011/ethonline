import { expect } from "chai";
import { ethers, network } from "hardhat";

async function fixture(face = 901n, principal = 800n, initialCollection = face) {
  const [admin, trustee, servicer, ...accounts] = await ethers.getSigners();
  const holders = accounts.slice(0, 2).sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
  const hts = await (await ethers.getContractFactory("MockHtsAssociation")).deploy();
  await network.provider.send("hardhat_setCode", ["0x0000000000000000000000000000000000000167", await ethers.provider.getCode(await hts.getAddress())]);
  const token = await (await ethers.getContractFactory("MockAssociationToken")).deploy();
  const asset = await (await ethers.getContractFactory("MockSnapshotAsset")).deploy();
  const registry = await (await ethers.getContractFactory("ReceivablePoolRegistry")).deploy(admin.address);
  const adapter = await (await ethers.getContractFactory("SnapshotPayoutAdapter")).deploy(await asset.getAddress(), await token.getAddress(), await registry.getAddress());
  const poolId = ethers.id("rounding-pool"), distributionId = ethers.id("rounding-distribution");
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  const leaf = { schemaVersion: 1, fuIdHash: ethers.id("FU-001"), obligorIdHash: ethers.id("OBL-001"), faceValue: face, dueDate: now - 1, acceptedAt: now - 100, currency: "0x494e52", evidenceHash: ethers.id("evidence") };
  const commitment = { poolId, poolRoot: await registry.hashReceivableLeaf(leaf), eligibilityRoot: ethers.id("eligible"), manifestHash: ethers.id("manifest"), assignmentDocumentHash: ethers.id("assignment"), originator: admin.address, trustee: trustee.address, originalFaceValue: face, originalInvestorPrincipal: principal, totalUnits: 3n, retainedUnitsAtIssuance: 0n, maturity: now + 1000 };
  await registry.createPool(commitment); await registry.activatePool(poolId, await asset.getAddress(), await adapter.getAddress(), await token.getAddress()); await registry.initializePayoutAdapter(poolId);
  await registry.grantRole(await registry.TRUSTEE_ROLE(), trustee.address); await registry.grantRole(await registry.SERVICER_ROLE(), servicer.address); await registry.grantRole(await registry.PAYOUT_EXECUTOR_ROLE(), servicer.address);
  await token.mint(await adapter.getAddress(), initialCollection); await registry.connect(servicer).recordCollection(poolId, ethers.id("cash"), ethers.id("cash-payload"), initialCollection, leaf, []);
  await asset.setBalance(holders[0]!.address, 1n); await asset.setBalance(holders[1]!.address, 2n); await asset.setSnapshot(1n, holders.map(holder => holder.address), [1n, 2n]);
  await token.setAssociated(holders[0]!.address, true); await token.setAssociated(holders[1]!.address, true);
  return { admin, trustee, servicer, holders, token, asset, registry, adapter, poolId, distributionId, commitment, leaf };
}

describe("Largest-remainder exact payouts and closure", () => {
  it("rejects a correctly bound legacy adapter that lacks the exact payout capability", async () => {
    const [admin] = await ethers.getSigners(); const token = await (await ethers.getContractFactory("MockPaymentToken")).deploy(); const asset = await (await ethers.getContractFactory("MockSnapshotAsset")).deploy(); const registry = await (await ethers.getContractFactory("ReceivablePoolRegistry")).deploy(admin.address);
    const legacy = await (await ethers.getContractFactory("MockLegacyPayoutBinding")).deploy(await asset.getAddress(), await token.getAddress(), await registry.getAddress());
    const poolId = ethers.id("legacy-capability"); await registry.createPool({ poolId, poolRoot: ethers.id("root"), eligibilityRoot: ethers.id("eligibility"), manifestHash: ethers.id("manifest"), assignmentDocumentHash: ethers.id("assignment"), originator: admin.address, trustee: admin.address, originalFaceValue: 100n, originalInvestorPrincipal: 98n, totalUnits: 100n, retainedUnitsAtIssuance: 5n, maturity: 2000000000 });
    await expect(registry.activatePool(poolId, await asset.getAddress(), await legacy.getAddress(), await token.getAddress())).to.be.revertedWithCustomError(registry, "UnsupportedPayoutVersion");
    expect(await registry.activePoolId()).to.equal(ethers.ZeroHash);
  });
  it("enforces role boundaries on every mutation entry point", async () => {
    const f = await fixture(), outsider = f.registry.connect(f.holders[0]!);
    const source = ethers.id("unauthorized"), payload = ethers.id("payload"), decision = ethers.id("decision");
    const calls = [
      () => outsider.createPool({ ...f.commitment, poolId: ethers.id("other") }),
      async () => outsider.activatePool(f.poolId, await f.asset.getAddress(), await f.adapter.getAddress(), await f.token.getAddress()),
      () => outsider.initializePayoutAdapter(f.poolId), () => outsider.recordCollection(f.poolId, source, payload, 1n, f.leaf, []),
      () => outsider.markDelinquent(f.poolId, source, payload, f.leaf, []), () => outsider.markDefault(f.poolId, source, payload, 0n, f.leaf, []),
      () => outsider.cureReceivable(f.poolId, source, payload, f.leaf, []), () => outsider.reviseRecoveryEstimate(f.poolId, source, payload, 0n, f.leaf, []),
      () => outsider.writeOffReceivable(f.poolId, source, payload, decision, f.leaf, []), () => outsider.writeDownPrincipal(f.poolId, source, payload, 1n, decision),
      () => outsider.approveDistribution(f.poolId, f.distributionId, 1, 800n, 101n, []), () => outsider.executeDistributionBatch(f.distributionId, [], []),
      () => outsider.finalizeDistribution(f.distributionId), () => outsider.cancelDistribution(f.distributionId, source, payload, decision),
      () => outsider.markMatured(f.poolId), () => outsider.closePool(f.poolId), () => outsider.pause(), () => outsider.unpause(),
    ];
    for (const call of calls) await expect(call()).to.be.revertedWithCustomError(f.registry, "AccessControlUnauthorizedAccount");
    expect((await f.registry.getPool(f.poolId)).availableCash).to.equal(901n);
  });
  it("allocates the former 901/3 residual, preserves exact components, and closes after real adapter payment and holder retirement", async () => {
    const f = await fixture();
    expect(901n / 3n + 901n * 2n / 3n).to.equal(900n); // Legacy floor vector intentionally leaves one.
    const entries = [
      { holder: f.holders[0]!.address, snapshotBalance: 1n, cashAmount: 300n, principalAmount: 267n, incomeAmount: 33n },
      { holder: f.holders[1]!.address, snapshotBalance: 2n, cashAmount: 601n, principalAmount: 533n, incomeAmount: 68n },
    ];
    await expect(f.registry.connect(f.trustee).approveDistribution(f.poolId, f.distributionId, 1, 800n, 101n, [entries[0], { ...entries[1], cashAmount: 600n, incomeAmount: 67n }])).to.be.revertedWithCustomError(f.registry, "EntitlementInvalid");
    await expect(f.registry.connect(f.trustee).approveDistribution(f.poolId, f.distributionId, 1, 800n, 101n, [{ ...entries[0], cashAmount: 301n, incomeAmount: 34n }, { ...entries[1], cashAmount: 600n, incomeAmount: 67n }])).to.be.revertedWithCustomError(f.registry, "EntitlementInvalid");
    await expect(f.registry.connect(f.trustee).approveDistribution(f.poolId, f.distributionId, 1, 800n, 101n, [{ ...entries[0], principalAmount: 266n, incomeAmount: 34n }, { ...entries[1], principalAmount: 534n, incomeAmount: 67n }])).to.be.revertedWithCustomError(f.registry, "EntitlementInvalid");
    await f.registry.connect(f.trustee).approveDistribution(f.poolId, f.distributionId, 1, 800n, 101n, entries);
    const hashes = await Promise.all(entries.map(entry => f.registry.hashEntitlement(entry)));
    await expect(f.registry.connect(f.servicer).executeDistributionBatch(f.distributionId, [entries[1], entries[1]], [[hashes[0]!], [hashes[0]!]])).to.be.revertedWithCustomError(f.registry, "PayoutResultInvalid");
    await f.registry.connect(f.servicer).executeDistributionBatch(f.distributionId, [entries[1]], [[hashes[0]!]]);
    expect(await f.token.balanceOf(f.holders[1]!.address)).to.equal(601n);
    expect((await f.registry.getPool(f.poolId)).reservedCash).to.equal(300n);
    await expect(f.registry.connect(f.servicer).executeDistributionBatch(f.distributionId, [{ ...entries[0], cashAmount: 301n, incomeAmount: 34n }], [[hashes[1]!]])).to.be.revertedWithCustomError(f.registry, "EntitlementProofInvalid");
    await f.registry.connect(f.servicer).executeDistributionBatch(f.distributionId, [entries[0]], [[hashes[1]!]]);
    await f.registry.connect(f.trustee).finalizeDistribution(f.distributionId);
    const distribution = await f.registry.getDistribution(f.distributionId), pool = await f.registry.getPool(f.poolId);
    expect(distribution.cashPaid).to.equal(901n); expect(distribution.principalPaid).to.equal(800n); expect(distribution.incomePaid).to.equal(101n);
    expect(pool.availableCash).to.equal(0n); expect(pool.reservedCash).to.equal(0n); expect(pool.reservedPrincipal).to.equal(0n); expect(pool.investorPrincipalOutstanding).to.equal(0n);
    expect(await f.token.balanceOf(await f.adapter.getAddress())).to.equal(0n);
    await ethers.provider.send("evm_setNextBlockTimestamp", [f.commitment.maturity]); await f.registry.connect(f.trustee).markMatured(f.poolId);
    await f.asset.connect(f.holders[0]!).retire(1n); await f.asset.connect(f.holders[1]!).retire(2n);
    await expect(f.registry.connect(f.trustee).closePool(f.poolId)).to.emit(f.registry, "PoolClosed");
  });
  it("resolves zero cash during approval without HTS transfer or cash receipt and still permits prepayment cancellation", async () => {
    const f = await fixture(1n, 1n);
    await f.token.setAssociated(f.holders[0]!.address, false);
    const entries = [
      { holder: f.holders[0]!.address, snapshotBalance: 1n, cashAmount: 0n, principalAmount: 0n, incomeAmount: 0n },
      { holder: f.holders[1]!.address, snapshotBalance: 2n, cashAmount: 1n, principalAmount: 1n, incomeAmount: 0n },
    ];
    const approval = f.registry.connect(f.trustee).approveDistribution(f.poolId, f.distributionId, 1, 1n, 0n, entries);
    await expect(approval).to.emit(f.registry, "HolderNoPaymentDue").withArgs(f.distributionId, f.holders[0]!.address);
    await expect(approval).not.to.emit(f.registry, "HolderPaid"); await expect(approval).not.to.emit(f.token, "Transfer");
    expect(await f.registry.holderPaid(f.distributionId, f.holders[0]!.address)).to.equal(true); expect(await f.registry.zeroEntitlementCount(f.distributionId)).to.equal(1n);
    expect((await f.registry.getDistribution(f.distributionId)).paidCount).to.equal(1n);
    await f.registry.connect(f.trustee).cancelDistribution(f.distributionId, ethers.id("cancel"), ethers.id("cancel-payload"), ethers.id("decision"));
    expect((await f.registry.getPool(f.poolId)).availableCash).to.equal(1n); expect(await f.registry.pendingDistributions(f.poolId)).to.equal(0n);
  });
  it("zero resolutions plus a positive exact payment finalize with every holder resolved", async () => {
    const f = await fixture(1n, 1n);
    await f.token.setAssociated(f.holders[0]!.address, false);
    const entries = [{ holder: f.holders[0]!.address, snapshotBalance: 1n, cashAmount: 0n, principalAmount: 0n, incomeAmount: 0n }, { holder: f.holders[1]!.address, snapshotBalance: 2n, cashAmount: 1n, principalAmount: 1n, incomeAmount: 0n }];
    await f.registry.connect(f.trustee).approveDistribution(f.poolId, f.distributionId, 1n, 1n, 0n, entries);
    const zeroHash = await f.registry.hashEntitlement(entries[0]); await f.registry.connect(f.servicer).executeDistributionBatch(f.distributionId, [entries[1]], [[zeroHash]]);
    await f.registry.connect(f.trustee).finalizeDistribution(f.distributionId);
    expect((await f.registry.getDistribution(f.distributionId)).paidCount).to.equal(2n); expect((await f.registry.getPool(f.poolId)).availableCash).to.equal(0n);
    expect(await f.token.balanceOf(f.holders[0]!.address)).to.equal(0n); expect(await f.token.balanceOf(f.holders[1]!.address)).to.equal(1n);
  });
  it("does not pay original nominal principal again when later collections become income", async () => {
    const f = await fixture(1000n, 500n, 500n);
    const principalEntries = [{ holder: f.holders[0]!.address, snapshotBalance: 1n, cashAmount: 167n, principalAmount: 167n, incomeAmount: 0n }, { holder: f.holders[1]!.address, snapshotBalance: 2n, cashAmount: 333n, principalAmount: 333n, incomeAmount: 0n }];
    await f.registry.connect(f.trustee).approveDistribution(f.poolId, f.distributionId, 1, 500n, 0n, principalEntries);
    let hashes = await Promise.all(principalEntries.map(entry => f.registry.hashEntitlement(entry)));
    await f.registry.connect(f.servicer).executeDistributionBatch(f.distributionId, principalEntries, [[hashes[1]!], [hashes[0]!]]); await f.registry.connect(f.trustee).finalizeDistribution(f.distributionId);
    expect((await f.registry.getPool(f.poolId)).investorPrincipalOutstanding).to.equal(0n);
    await f.token.mint(await f.adapter.getAddress(), 500n); await f.registry.connect(f.servicer).recordCollection(f.poolId, ethers.id("later-cash"), ethers.id("later-payload"), 500n, f.leaf, []);
    await f.asset.setSnapshot(2, f.holders.map(holder => holder.address), [1n, 2n]); const second = ethers.id("second-income");
    await expect(f.registry.connect(f.trustee).approveDistribution(f.poolId, second, 2, 500n, 0n, principalEntries)).to.be.revertedWithCustomError(f.registry, "InvalidAmount");
    const incomeEntries = principalEntries.map(entry => ({ ...entry, principalAmount: 0n, incomeAmount: entry.cashAmount }));
    await f.registry.connect(f.trustee).approveDistribution(f.poolId, second, 2, 0n, 500n, incomeEntries); hashes = await Promise.all(incomeEntries.map(entry => f.registry.hashEntitlement(entry)));
    await f.registry.connect(f.servicer).executeDistributionBatch(second, incomeEntries, [[hashes[1]!], [hashes[0]!]]); await f.registry.connect(f.trustee).finalizeDistribution(second);
    expect((await f.registry.getDistribution(second)).principalPaid).to.equal(0n); expect((await f.registry.getDistribution(second)).incomePaid).to.equal(500n);
    expect((await f.registry.getPool(f.poolId)).totalCashPaid).to.equal(1000n);
  });
});
