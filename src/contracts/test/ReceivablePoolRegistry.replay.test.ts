import { expect } from "chai";
import { ethers } from "hardhat";

async function setupReplayFixture() {
  const [admin, originator] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory("MockPaymentToken")).deploy();
  const asset = await (await ethers.getContractFactory("MockSnapshotAsset")).deploy();
  const payout = await (await ethers.getContractFactory("MockLifeCycleCashFlow")).deploy(await token.getAddress());
  const registry = await (await ethers.getContractFactory("ReceivablePoolRegistry")).deploy(admin.address);
  await payout.setOperator(await registry.getAddress());
  await payout.setAsset(await asset.getAddress());
  const leaf = {
    schemaVersion: 1,
    fuIdHash: ethers.id("FU-REPLAY"),
    obligorIdHash: ethers.id("OBLIGOR-REPLAY"),
    faceValue: 1_000n,
    dueDate: (await ethers.provider.getBlock("latest"))!.timestamp - 1,
    currency: "0x494e52",
    acceptedAt: 1_700_000_000,
    evidenceHash: ethers.id("evidence-replay"),
  };
  const poolId = ethers.id("POOL-REPLAY-A");
  const otherPoolId = ethers.id("POOL-REPLAY-B");
  for (const id of [poolId, otherPoolId]) {
    await registry.createPool({
      poolId: id,
      poolRoot: await registry.hashReceivableLeaf(leaf),
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
    if (id === poolId) await registry.activatePool(id, await asset.getAddress(), await payout.getAddress(), await token.getAddress());
  }
  await registry.grantRole(await registry.SERVICER_ROLE(), admin.address);
  await registry.grantRole(await registry.TRUSTEE_ROLE(), admin.address);
  await token.mint(await payout.getAddress(), 2_000n);
  return { registry, poolId, otherPoolId, leaf, sourceId: ethers.id("SOURCE-REPLAY"), payloadHash: ethers.id("external-payload") };
}

describe("ReceivablePoolRegistry executed-payload replay binding", () => {
  it("rejects changed amount, complete leaf fields and proof despite the same application fingerprint", async () => {
    const { registry, poolId, leaf, sourceId, payloadHash } = await setupReplayFixture();
    await registry.recordCollection(poolId, sourceId, payloadHash, 100n, leaf, []);

    for (const amount of [0n, 99n, 101n]) {
      await expect(registry.recordCollection(poolId, sourceId, payloadHash, amount, leaf, []))
        .to.be.revertedWithCustomError(registry, "ConflictingCollectionEvent");
    }
    const changedLeaves = [
      { ...leaf, schemaVersion: 2 },
      { ...leaf, fuIdHash: ethers.id("other-fu") },
      { ...leaf, obligorIdHash: ethers.id("other-obligor") },
      { ...leaf, faceValue: 999n },
      { ...leaf, dueDate: leaf.dueDate + 1 },
      { ...leaf, currency: "0x555344" },
      { ...leaf, acceptedAt: leaf.acceptedAt + 1 },
      { ...leaf, evidenceHash: ethers.id("other-evidence") },
    ];
    for (const changedLeaf of changedLeaves) {
      await expect(registry.recordCollection(poolId, sourceId, payloadHash, 100n, changedLeaf, []))
        .to.be.revertedWithCustomError(registry, "ConflictingCollectionEvent");
    }
    await expect(registry.recordCollection(poolId, sourceId, payloadHash, 100n, leaf, [ethers.id("other-proof")]))
      .to.be.revertedWithCustomError(registry, "ConflictingCollectionEvent");
    await expect(registry.recordCollection(poolId, sourceId, payloadHash, 100n, leaf, []))
      .to.emit(registry, "CollectionReplayIgnored").withArgs(poolId, sourceId);
    const pool = await registry.getPool(poolId);
    expect(pool.availableCash).to.equal(100n);
    expect(pool.performingFaceOutstanding).to.equal(900n);
    expect(await registry.collectedByReceivable(poolId, leaf.fuIdHash)).to.equal(100n);
  });

  it("rejects collection cross-pool reuse but accepts a distinct source identity", async () => {
    const { registry, poolId, otherPoolId, leaf, sourceId, payloadHash } = await setupReplayFixture();
    await registry.recordCollection(poolId, sourceId, payloadHash, 100n, leaf, []);
    await expect(registry.recordCollection(otherPoolId, sourceId, payloadHash, 100n, leaf, []))
      .to.be.revertedWithCustomError(registry, "InvalidState");
    await registry.recordCollection(poolId, ethers.id("second-source"), payloadHash, 100n, leaf, []);
    expect((await registry.getPool(poolId)).availableCash).to.equal(200n);
    expect((await registry.getPool(otherPoolId)).availableCash).to.equal(0n);
  });

  it("binds delinquency to the full leaf, proof, pool and external fingerprint", async () => {
    const { registry, poolId, otherPoolId, leaf, sourceId, payloadHash } = await setupReplayFixture();
    await registry.markDelinquent(poolId, sourceId, payloadHash, leaf, []);
    await expect(registry.markDelinquent(poolId, sourceId, payloadHash, { ...leaf, evidenceHash: ethers.id("changed") }, []))
      .to.be.revertedWithCustomError(registry, "ConflictingServicingEvent");
    await expect(registry.markDelinquent(poolId, sourceId, payloadHash, { ...leaf, fuIdHash: ethers.id("changed") }, []))
      .to.be.revertedWithCustomError(registry, "ConflictingServicingEvent");
    await expect(registry.markDelinquent(poolId, sourceId, payloadHash, leaf, [ethers.id("changed")]))
      .to.be.revertedWithCustomError(registry, "ConflictingServicingEvent");
    await expect(registry.markDelinquent(otherPoolId, sourceId, payloadHash, leaf, []))
      .to.be.revertedWithCustomError(registry, "InvalidState");
    await expect(registry.markDelinquent(poolId, sourceId, ethers.id("changed"), leaf, []))
      .to.be.revertedWithCustomError(registry, "ConflictingServicingEvent");
    await expect(registry.markDelinquent(poolId, sourceId, payloadHash, leaf, []))
      .to.emit(registry, "ServicingReplayIgnored").withArgs(poolId, sourceId);
    expect((await registry.getPool(poolId)).delinquentFaceOutstanding).to.equal(1_000n);
    expect((await registry.getPool(otherPoolId)).delinquentFaceOutstanding).to.equal(0n);
  });

  it("rejects servicing event-type collisions instead of falsely acknowledging a status change", async () => {
    const { registry, poolId, leaf, sourceId, payloadHash } = await setupReplayFixture();
    await registry.markDelinquent(poolId, sourceId, payloadHash, leaf, []);
    await expect(registry.markDefault(poolId, sourceId, payloadHash, 400n, leaf, []))
      .to.be.revertedWithCustomError(registry, "ConflictingServicingEvent");
    expect(await registry.receivableStatus(poolId, leaf.fuIdHash)).to.equal(2n);
    expect((await registry.getPool(poolId)).defaultedFaceOutstanding).to.equal(0n);
  });

  it("binds default recovery and rejects reverse event-type collisions", async () => {
    const { registry, poolId, otherPoolId, leaf, sourceId, payloadHash } = await setupReplayFixture();
    await registry.markDelinquent(poolId, ethers.id("earlier-delinquency"), payloadHash, leaf, []);
    await registry.markDefault(poolId, sourceId, payloadHash, 400n, leaf, []);
    await expect(registry.markDefault(poolId, sourceId, payloadHash, 401n, leaf, []))
      .to.be.revertedWithCustomError(registry, "ConflictingServicingEvent");
    await expect(registry.markDefault(otherPoolId, sourceId, payloadHash, 400n, leaf, []))
      .to.be.revertedWithCustomError(registry, "InvalidState");
    await expect(registry.markDefault(poolId, sourceId, payloadHash, 400n, { ...leaf, faceValue: 999n }, []))
      .to.be.revertedWithCustomError(registry, "ConflictingServicingEvent");
    await expect(registry.markDefault(poolId, sourceId, payloadHash, 400n, leaf, [ethers.id("other-proof")]))
      .to.be.revertedWithCustomError(registry, "ConflictingServicingEvent");
    await expect(registry.markDelinquent(poolId, sourceId, payloadHash, leaf, []))
      .to.be.revertedWithCustomError(registry, "ConflictingServicingEvent");
    await expect(registry.markDefault(poolId, sourceId, payloadHash, 400n, leaf, []))
      .to.emit(registry, "ServicingReplayIgnored").withArgs(poolId, sourceId);
    expect((await registry.getPool(poolId)).estimatedDefaultRecoveries).to.equal(400n);
    expect(await registry.estimatedRecoveryByReceivable(poolId, leaf.fuIdHash)).to.equal(400n);
  });

  for (const collectionFirst of [true, false]) {
    it(`keeps collection and servicing namespaces independent (${collectionFirst ? "collection" : "servicing"} first)`, async () => {
      const { registry, poolId, otherPoolId, leaf, sourceId, payloadHash } = await setupReplayFixture();
      const servicingHash = ethers.id("different-external-servicing-payload");
      const collect = () => registry.recordCollection(poolId, sourceId, payloadHash, 100n, leaf, []);
      const service = () => registry.markDelinquent(poolId, sourceId, servicingHash, leaf, []);
      if (collectionFirst) { await collect(); await service(); }
      else { await service(); await collect(); }
      await expect(collect()).to.emit(registry, "CollectionReplayIgnored").withArgs(poolId, sourceId);
      await expect(service()).to.emit(registry, "ServicingReplayIgnored").withArgs(poolId, sourceId);
      expect(await registry.collectionPool(sourceId)).to.equal(poolId);
      expect(await registry.collectionPayloadHash(sourceId)).to.equal(payloadHash);
      expect(await registry.servicingPayloadHash(sourceId)).to.equal(servicingHash);
      expect((await registry.getPool(poolId)).availableCash).to.equal(100n);
      expect((await registry.getPool(poolId)).delinquentFaceOutstanding).to.equal(900n);
      expect((await registry.getPool(otherPoolId)).delinquentFaceOutstanding).to.equal(0n);
    });
  }

  it("does not consume failed first attempts or treat validation errors as replay conflicts", async () => {
    const { registry, poolId, leaf, sourceId, payloadHash } = await setupReplayFixture();
    const badProof = [ethers.id("invalid-proof")];
    await expect(registry.recordCollection(poolId, sourceId, payloadHash, 100n, leaf, badProof))
      .to.be.revertedWithCustomError(registry, "InvalidReceivableProof");
    expect(await registry.collectionPayloadHash(sourceId)).to.equal(ethers.ZeroHash);
    await registry.recordCollection(poolId, sourceId, payloadHash, 100n, leaf, []);
    await expect(registry.markDelinquent(poolId, sourceId, payloadHash, leaf, badProof))
      .to.be.revertedWithCustomError(registry, "InvalidReceivableProof");
    expect(await registry.servicingPayloadHash(sourceId)).to.equal(ethers.ZeroHash);
    await registry.markDelinquent(poolId, sourceId, payloadHash, leaf, []);
    expect((await registry.getPool(poolId)).delinquentFaceOutstanding).to.equal(900n);
  });
});
