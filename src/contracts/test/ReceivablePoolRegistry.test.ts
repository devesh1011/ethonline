import { expect } from "chai";
import { ethers } from "hardhat";

describe("ReceivablePoolRegistry", () => {
  it("records one collection and pays immutable snapshot entitlements once", async () => {
    const [admin, originator, holderA, holderB] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockPaymentToken");
    const token = await Token.deploy();
    const Asset = await ethers.getContractFactory("MockSnapshotAsset");
    const asset = await Asset.deploy();
    const Payout = await ethers.getContractFactory("MockLifeCycleCashFlow");
    const payout = await Payout.deploy(await token.getAddress());
    const Registry = await ethers.getContractFactory("ReceivablePoolRegistry");
    const registry = await Registry.deploy(admin.address);

    const poolId = ethers.id("POOL-001");
    const fuIdHash = ethers.id("FU-001");
    const leaf = {
      schemaVersion: 1,
      fuIdHash,
      obligorIdHash: ethers.id("OBLIGOR-01"),
      faceValue: 1_000n,
      dueDate: 2_000_000_000,
      currency: "0x494e52",
      acceptedAt: 1_700_000_000,
      evidenceHash: ethers.id("evidence"),
    };
    const leafHash = await registry.hashReceivableLeaf(leaf);

    await registry.createPool({
      poolId,
      poolRoot: leafHash,
      eligibilityRoot: ethers.id("eligibility"),
      manifestHash: ethers.id("manifest"),
      assignmentDocumentHash: ethers.id("assignment"),
      originator: originator.address,
      trustee: admin.address,
      originalFaceValue: 1_000n,
      originalInvestorPrincipal: 980n,
      totalUnits: 1_000n,
      retainedUnitsAtIssuance: 50n,
      maturity: 2_000_000_000,
    });
    await payout.setOperator(await registry.getAddress());
    await payout.setAsset(await asset.getAddress());
    await registry.activatePool(poolId, await asset.getAddress(), await payout.getAddress(), await token.getAddress());
    await registry.grantRole(await registry.SERVICER_ROLE(), admin.address);
    await registry.grantRole(await registry.TRUSTEE_ROLE(), admin.address);
    await registry.grantRole(await registry.PAYOUT_EXECUTOR_ROLE(), admin.address);
    await payout.setOperator(await registry.getAddress());

    await token.mint(await payout.getAddress(), 1_000n);
    const sourceEventId = ethers.id("mock-treds:SETTLE-001");
    const payloadHash = ethers.id("payload-v1");
    await registry.recordCollection(poolId, sourceEventId, payloadHash, 1_000n, leaf, []);

    const afterCollection = await registry.getPool(poolId);
    expect(afterCollection.availableCash).to.equal(1_000n);
    expect(afterCollection.performingFaceOutstanding).to.equal(0n);

    await expect(registry.recordCollection(poolId, sourceEventId, payloadHash, 1_000n, leaf, []))
      .to.emit(registry, "CollectionReplayIgnored")
      .withArgs(poolId, sourceEventId);
    expect((await registry.getPool(poolId)).availableCash).to.equal(1_000n);
    await expect(
      registry.recordCollection(poolId, sourceEventId, ethers.id("payload-v2"), 1_000n, leaf, []),
    ).to.be.revertedWithCustomError(registry, "ConflictingCollectionEvent");

    await asset.setSnapshot(1n, [holderA.address, holderB.address], [50n, 950n]);
    const entitlements = [
      { holder: holderA.address, snapshotBalance: 50n, cashAmount: 49n, principalAmount: 49n, incomeAmount: 0n },
      { holder: holderB.address, snapshotBalance: 950n, cashAmount: 931n, principalAmount: 931n, incomeAmount: 0n },
    ].sort((left, right) => left.holder.toLowerCase().localeCompare(right.holder.toLowerCase()));
    const distributionId = ethers.id("DIST-001");
    await expect(registry.approveDistribution(poolId, ethers.id("INCOME-BEFORE-PRINCIPAL"), 1n, 0n, 980n, entitlements))
      .to.be.revertedWithCustomError(registry, "InvalidAmount");
    await registry.approveDistribution(poolId, distributionId, 1n, 980n, 0n, entitlements);

    const leaves = await Promise.all(entitlements.map((entry) => registry.hashEntitlement(entry)));
    const proofs = [[leaves[1]], [leaves[0]]];
    await registry.executeDistributionBatch(distributionId, entitlements, proofs);
    await registry.finalizeDistribution(distributionId);

    expect(await token.balanceOf(holderA.address)).to.equal(49n);
    expect(await token.balanceOf(holderB.address)).to.equal(931n);
    expect((await registry.getPool(poolId)).investorPrincipalOutstanding).to.equal(0n);

    await expect(registry.executeDistributionBatch(distributionId, entitlements, proofs)).to.be.revertedWithCustomError(
      registry,
      "DistributionNotPayable",
    );
  });

  it("moves contractual face into default without reducing principal", async () => {
    const [admin, originator] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockPaymentToken");
    const token = await Token.deploy();
    const Asset = await ethers.getContractFactory("MockSnapshotAsset");
    const asset = await Asset.deploy();
    const Payout = await ethers.getContractFactory("MockLifeCycleCashFlow");
    const payout = await Payout.deploy(await token.getAddress());
    const Registry = await ethers.getContractFactory("ReceivablePoolRegistry");
    const registry = await Registry.deploy(admin!.address);
    const poolId = ethers.id("POOL-DEFAULT");
    const leaf = {
      schemaVersion: 1,
      fuIdHash: ethers.id("FU-D"),
      obligorIdHash: ethers.id("OBLIGOR-D"),
      faceValue: 1_000n,
      dueDate: 2_000_000_000,
      currency: "0x494e52",
      acceptedAt: 1_700_000_000,
      evidenceHash: ethers.id("evidence-d"),
    };
    const leafHash = await registry.hashReceivableLeaf!(leaf);
    await registry.createPool!({
      poolId,
      poolRoot: leafHash,
      eligibilityRoot: ethers.id("eligibility"),
      manifestHash: ethers.id("manifest"),
      assignmentDocumentHash: ethers.id("assignment"),
      originator: originator!.address,
      trustee: admin!.address,
      originalFaceValue: 1_000n,
      originalInvestorPrincipal: 980n,
      totalUnits: 1_000n,
      retainedUnitsAtIssuance: 50n,
      maturity: 2_000_000_000,
    });
    await payout.setOperator(await registry.getAddress());
    await payout.setAsset(await asset.getAddress());
    await registry.activatePool!(poolId, await asset.getAddress(), await payout.getAddress(), await token.getAddress());
    await registry.grantRole!(await registry.SERVICER_ROLE!(), admin!.address);
    await registry.grantRole!(await registry.TRUSTEE_ROLE!(), admin!.address);

    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    if (now <= leaf.dueDate) await ethers.provider.send("evm_setNextBlockTimestamp", [leaf.dueDate + 1]);
    await registry.markDelinquent!(poolId, ethers.id("DELINQUENT-D"), ethers.id("payload-d1"), leaf, []);
    await registry.markDefault!(poolId, ethers.id("DEFAULT-D"), ethers.id("payload-d2"), 400n, leaf, []);

    const pool = await registry.getPool!(poolId);
    expect(pool.performingFaceOutstanding).to.equal(0n);
    expect(pool.delinquentFaceOutstanding).to.equal(0n);
    expect(pool.defaultedFaceOutstanding).to.equal(1_000n);
    expect(pool.estimatedDefaultRecoveries).to.equal(400n);
    expect(pool.investorPrincipalOutstanding).to.equal(980n);
  });
});
