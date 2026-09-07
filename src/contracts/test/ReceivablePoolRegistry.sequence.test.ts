import { expect } from "chai";
import { ethers, network } from "hardhat";

/** Generated money values and execution orders exercise real Registry/adapter calls.
 * This model tracks independent cash, face, principal, loss and reservation equations. */
describe("Deterministic accounting event sequences", () => {
  for (const seed of [11, 28, 47, 62, 83, 104]) {
    it(`conserves independent ledgers through replay, servicing, partial payouts and loss decisions (seed ${seed})`, async () => {
      let randomState = seed;
      const random = (max: number) => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState % max; };
      const [admin, trustee, servicer, ...accounts] = await ethers.getSigners();
      const holders = accounts.slice(0, 2).sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
      const hts = await (await ethers.getContractFactory("MockHtsAssociation")).deploy();
      await network.provider.send("hardhat_setCode", ["0x0000000000000000000000000000000000000167", await ethers.provider.getCode(await hts.getAddress())]);
      const token = await (await ethers.getContractFactory("MockAssociationToken")).deploy();
      const asset = await (await ethers.getContractFactory("MockSnapshotAsset")).deploy();
      const registry = await (await ethers.getContractFactory("ReceivablePoolRegistry")).deploy(admin.address);
      const adapter = await (await ethers.getContractFactory("SnapshotPayoutAdapter")).deploy(await asset.getAddress(), await token.getAddress(), await registry.getAddress());
      const now = (await ethers.provider.getBlock("latest"))!.timestamp, maturity = now + 5000;
      const leaves = [1, 2].map(index => ({ schemaVersion: 1, fuIdHash: ethers.id(`FU-${index}`), obligorIdHash: ethers.id(`OBL-${index}`), faceValue: 500n, dueDate: now - 1, acceptedAt: now - 1000, currency: "0x494e52", evidenceHash: ethers.id(`evidence-${seed}-${index}`) }));
      const leafHashes = await Promise.all(leaves.map(leaf => registry.hashReceivableLeaf(leaf)));
      const poolId = ethers.id(`sequence:${seed}`), root = ethers.keccak256(ethers.concat([...leafHashes].sort()));
      await registry.createPool({ poolId, poolRoot: root, eligibilityRoot: ethers.id("eligible"), manifestHash: ethers.id("manifest"), assignmentDocumentHash: ethers.id("assignment"), originator: admin.address, trustee: trustee.address, originalFaceValue: 1000n, originalInvestorPrincipal: 980n, totalUnits: 3n, retainedUnitsAtIssuance: 0n, maturity });
      await registry.activatePool(poolId, await asset.getAddress(), await adapter.getAddress(), await token.getAddress()); await registry.initializePayoutAdapter(poolId);
      await registry.grantRole(await registry.TRUSTEE_ROLE(), trustee.address); await registry.grantRole(await registry.SERVICER_ROLE(), servicer.address); await registry.grantRole(await registry.PAYOUT_EXECUTOR_ROLE(), servicer.address);
      await asset.setBalance(holders[0]!.address, 1n); await asset.setBalance(holders[1]!.address, 2n);
      for (const holder of holders) await token.setAssociated(holder.address, true);
      const units = leaves.map(() => ({ status: "PERFORMING", collected: 0n, writtenOff: 0n, estimate: 0n }));
      const model = { cash: 0n, reserved: 0n, principal: 980n, reservedPrincipal: 0n, cashPaid: 0n, principalPaid: 0n, writtenDown: 0n, pending: 0n };
      const outstanding = (index: number) => 500n - units[index]!.collected - units[index]!.writtenOff;
      const event = (name: string) => [ethers.id(`${seed}:${name}`), ethers.id(`${seed}:${name}:payload`)] as const;
      const check = async () => {
        const pool = await registry.getPool(poolId), collected = units.reduce((n, u) => n + u.collected, 0n), losses = units.reduce((n, u) => n + u.writtenOff, 0n);
        const bucket = (status: string) => units.reduce((n, unit, index) => n + (unit.status === status ? outstanding(index) : 0n), 0n);
        expect(pool.performingFaceOutstanding).to.equal(bucket("PERFORMING")); expect(pool.delinquentFaceOutstanding).to.equal(bucket("DELINQUENT")); expect(pool.defaultedFaceOutstanding).to.equal(bucket("DEFAULTED"));
        expect(pool.realizedLosses).to.equal(losses); expect(pool.estimatedDefaultRecoveries).to.equal(units.reduce((n, unit) => n + unit.estimate, 0n));
        expect(pool.availableCash).to.equal(model.cash); expect(pool.reservedCash).to.equal(model.reserved); expect(pool.investorPrincipalOutstanding).to.equal(model.principal); expect(pool.reservedPrincipal).to.equal(model.reservedPrincipal); expect(pool.totalCashPaid).to.equal(model.cashPaid);
        expect(pool.performingFaceOutstanding + pool.delinquentFaceOutstanding + pool.defaultedFaceOutstanding + pool.realizedLosses + collected).to.equal(1000n);
        expect(model.cash + model.reserved + model.cashPaid).to.equal(collected); expect(model.principal + model.principalPaid + model.writtenDown).to.equal(980n); expect(model.reservedPrincipal).to.be.at.most(model.principal);
        expect(await registry.pendingDistributions(poolId)).to.equal(model.pending); expect(await registry.totalPrincipalWrittenDown(poolId)).to.equal(model.writtenDown);
        expect(await token.balanceOf(await adapter.getAddress())).to.equal(model.cash + model.reserved);
        expect(await token.balanceOf(holders[0]!.address) + await token.balanceOf(holders[1]!.address)).to.equal(model.cashPaid);
        for (let index = 0; index < units.length; index++) { expect(await registry.collectedByReceivable(poolId, leaves[index]!.fuIdHash)).to.equal(units[index]!.collected); expect(await registry.writtenOffByReceivable(poolId, leaves[index]!.fuIdHash)).to.equal(units[index]!.writtenOff); }
      };
      const collect = async (index: number, amount: bigint, name: string) => {
        await token.mint(await adapter.getAddress(), amount); await registry.connect(servicer).recordCollection(poolId, ...event(name), amount, leaves[index]!, [leafHashes[1 - index]!]);
        const unit = units[index]!; unit.collected += amount; if (unit.status === "DEFAULTED") unit.estimate -= amount < unit.estimate ? amount : unit.estimate; if (outstanding(index) === 0n) unit.status = "PAID";
        model.cash += amount; await check();
      };
      const delinquent = async (name: string) => { await registry.connect(servicer).markDelinquent(poolId, ...event(name), leaves[1]!, [leafHashes[0]!]); units[1]!.status = "DELINQUENT"; await check(); };
      const defaults = async (name: string) => { const estimate = BigInt(random(Number(outstanding(1) + 1n))); await registry.connect(trustee).markDefault(poolId, ...event(name), estimate, leaves[1]!, [leafHashes[0]!]); units[1]!.status = "DEFAULTED"; units[1]!.estimate = estimate; await check(); };
      await check();
      await expect(registry.connect(servicer).recordCollection(poolId, ...event("unfunded"), 1n, leaves[0]!, [leafHashes[1]!])).to.be.revertedWithCustomError(registry, "InsufficientCashCoverage"); await check();
      const firstCollection = BigInt(20 + random(80)); await collect(0, firstCollection, "cash-a");
      await expect(registry.connect(servicer).recordCollection(poolId, ...event("overcollection"), outstanding(0) + 1n, leaves[0]!, [leafHashes[1]!])).to.be.revertedWithCustomError(registry, "CollectionExceedsOutstanding"); await check();
      await expect(registry.connect(servicer).recordCollection(poolId, ...event("wrong-membership"), 1n, leaves[0]!, [])).to.be.revertedWithCustomError(registry, "InvalidReceivableProof"); await check();
      await registry.connect(servicer).recordCollection(poolId, ...event("cash-a"), firstCollection, leaves[0]!, [leafHashes[1]!]); await check();
      await expect(registry.connect(servicer).recordCollection(poolId, ...event("cash-a"), firstCollection + 1n, leaves[0]!, [leafHashes[1]!])).to.be.revertedWithCustomError(registry, "ConflictingCollectionEvent"); await check();
      await delinquent("late-1"); await collect(1, BigInt(20 + random(60)), "delinquent-cash"); await defaults("default-1"); await collect(1, BigInt(1 + random(20)), "recovery-cash");
      const estimate = BigInt(random(Number(outstanding(1) + 1n))); await registry.connect(trustee).reviseRecoveryEstimate(poolId, ...event("estimate"), estimate, leaves[1]!, [leafHashes[0]!]); units[1]!.estimate = estimate; await check();
      await registry.connect(trustee).cureReceivable(poolId, ...event("cure"), leaves[1]!, [leafHashes[0]!]); units[1]!.status = "PERFORMING"; units[1]!.estimate = 0n; await check();
      await delinquent("late-2"); await defaults("default-2");
      if (seed % 2) {
        const lost = outstanding(1); await registry.connect(trustee).writeOffReceivable(poolId, ...event("write-off"), ethers.id("audited loss"), leaves[1]!, [leafHashes[0]!]); units[1]!.writtenOff = lost; units[1]!.status = "WRITTEN_OFF"; units[1]!.estimate = 0n; await check();
        await expect(registry.connect(servicer).recordCollection(poolId, ...event("after-write-off"), 1n, leaves[1]!, [leafHashes[0]!])).to.be.revertedWithCustomError(registry, "InvalidState"); await check();
      }
      let snapshot = 1n;
      const approve = async (total: bigint) => {
        const snapshotId = snapshot++, distributionId = ethers.id(`${seed}:distribution:${snapshotId}`);
        const principal = total < model.principal - model.reservedPrincipal ? total : model.principal - model.reservedPrincipal, income = total - principal;
        // Independent two-holder closed form for weights 1:2: nearest integer to total/3.
        const firstCash = (total + 1n) / 3n, principalFloor = principal / 3n;
        const principalRemainder = principal - principal / 3n - principal * 2n / 3n;
        const firstGap = firstCash - principalFloor - income / 3n;
        const firstPrincipal = principalFloor + (firstGap < principalRemainder ? firstGap : principalRemainder), firstIncome = firstCash - firstPrincipal;
        const entries = [{ holder: holders[0]!.address, snapshotBalance: 1n, cashAmount: firstCash, principalAmount: firstPrincipal, incomeAmount: firstIncome }, { holder: holders[1]!.address, snapshotBalance: 2n, cashAmount: total - firstCash, principalAmount: principal - firstPrincipal, incomeAmount: income - firstIncome }];
        await asset.setSnapshot(snapshotId, holders.map(holder => holder.address), [1n, 2n]); await registry.connect(trustee).approveDistribution(poolId, distributionId, snapshotId, principal, income, entries);
        model.cash -= total; model.reserved += total; model.reservedPrincipal += principal; model.pending++; await check();
        const hashes = await Promise.all(entries.map(entry => registry.hashEntitlement(entry)));
        return { distributionId, snapshotId, total, principal, income, entries, proofs: [[hashes[1]!], [hashes[0]!]] };
      };
      const pay = async (distribution: Awaited<ReturnType<typeof approve>>, index: number, failFirst: boolean) => {
        const entry = distribution.entries[index]!;
        if (entry.cashAmount === 0n) { expect(await registry.holderPaid(distribution.distributionId, entry.holder)).to.equal(true); await check(); return; }
        if (failFirst) { await token.setBlocked(entry.holder, true); await expect(registry.connect(servicer).executeDistributionBatch(distribution.distributionId, [entry], [distribution.proofs[index]!])).to.be.revertedWithCustomError(token, "RecipientBlocked"); await check(); await token.setBlocked(entry.holder, false); }
        await registry.connect(servicer).executeDistributionBatch(distribution.distributionId, [entry], [distribution.proofs[index]!]);
        model.reserved -= entry.cashAmount; model.cashPaid += entry.cashAmount; model.principal -= entry.principalAmount; model.principalPaid += entry.principalAmount; model.reservedPrincipal -= entry.principalAmount; await check();
        await expect(registry.connect(servicer).executeDistributionBatch(distribution.distributionId, [entry], [distribution.proofs[index]!])).to.be.reverted; await check();
      };
      const finish = async (distribution: Awaited<ReturnType<typeof approve>>) => { await registry.connect(trustee).finalizeDistribution(distribution.distributionId); model.pending--; const value = await registry.getDistribution(distribution.distributionId); expect(value.cashPaid).to.equal(distribution.total); expect(value.principalPaid).to.equal(distribution.principal); expect(value.incomePaid).to.equal(distribution.income); await check(); };
      const a = await approve(model.cash / 2n), b = await approve(model.cash);
      await expect(registry.connect(trustee).approveDistribution(poolId, ethers.id(`${seed}:reuse`), a.snapshotId, a.principal, a.income, a.entries)).to.be.revertedWithCustomError(registry, "SnapshotAlreadyBound"); await check();
      if (seed % 2) {
        await registry.connect(trustee).cancelDistribution(b.distributionId, ...event("cancel"), ethers.id("revised payment date")); model.cash += b.total; model.reserved -= b.total; model.reservedPrincipal -= b.principal; model.pending--; await check();
        await registry.connect(trustee).cancelDistribution(b.distributionId, ...event("cancel"), ethers.id("revised payment date")); await check();
      }
      await expect(registry.connect(trustee).finalizeDistribution(a.distributionId)).to.be.revertedWithCustomError(registry, "DistributionNotPayable");
      const order = random(2); await pay(a, order, true); await pay(a, 1 - order, false); await finish(a);
      if (seed % 2 === 0) { await pay(b, 1, false); await pay(b, 0, false); await finish(b); }
      if (outstanding(0) > 0n) await collect(0, outstanding(0), "final-a"); if (units[1]!.status !== "WRITTEN_OFF" && outstanding(1) > 0n) await collect(1, outstanding(1), "final-b");
      const final = await approve(model.cash); await pay(final, 0, false); await pay(final, 1, false); await finish(final);
      if (model.principal > 0n) {
        const amount = model.principal; await registry.connect(trustee).writeDownPrincipal(poolId, ...event("principal-loss"), amount, ethers.id("explicit principal loss decision")); model.principal -= amount; model.writtenDown += amount; await check();
        await registry.connect(trustee).writeDownPrincipal(poolId, ...event("principal-loss"), amount, ethers.id("explicit principal loss decision")); await check();
      }
      await ethers.provider.send("evm_setNextBlockTimestamp", [maturity]); await registry.connect(trustee).markMatured(poolId);
      await expect(registry.connect(trustee).closePool(poolId)).to.be.revertedWithCustomError(registry, "UnresolvedPoolObligations");
      await asset.connect(holders[0]!).retire(1n); await asset.connect(holders[1]!).retire(2n); await registry.connect(trustee).closePool(poolId);
      expect((await registry.getPool(poolId)).status).to.equal(4n); expect(await registry.activePoolId()).to.equal(ethers.ZeroHash); await check();
    });
  }
});
