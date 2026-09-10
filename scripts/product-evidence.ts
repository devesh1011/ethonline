/** Keep browser data small; the verifier retains full calldata/log/native-transfer evidence. */
export function productEvidence(evidence: Record<string, any>) {
  const {
    version,
    generatedAt,
    network,
    chainId,
    simulatedBusinessData,
    dataAsOf,
    registry,
    payoutAdapter,
    pool,
    collection,
    distribution,
    transactions,
    verificationScope,
  } = evidence;
  const {
    securityId,
    securityAddress,
    snapshotId,
    balances,
    actors,
    configuration,
    transactions: atsTransactions,
  } = evidence.ats;
  const { tokenId, tokenAddress, participantBalances, decimals } =
    evidence.inrx;
  return {
    version,
    generatedAt,
    network,
    chainId,
    simulatedBusinessData,
    dataAsOf,
    ats: {
      securityId,
      securityAddress,
      snapshotId,
      balances,
      actors,
      configuration,
      transactions: atsTransactions,
    },
    inrx: { tokenId, tokenAddress, participantBalances, decimals },
    registry,
    payoutAdapter,
    pool,
    collection,
    distribution,
    transactions,
    verificationScope,
    transactionDetails: Object.fromEntries(
      Object.entries(evidence.transactionDetails).map(([name, value]) => [
        name,
        {
          consensusTimestamp: (value as { consensusTimestamp: string })
            .consensusTimestamp,
        },
      ])
    ),
  };
}

/** Retain evidence-verifier response fields; omit unrelated large execution diagnostics. */
export function compactNetworkFixtures(fixtures: Record<string, unknown>) {
  const omitted = new Set([
    "bloom",
    "state_changes",
    "bytecode",
    "runtime_bytecode",
    "failed_initcode",
    "access_list",
  ]);
  return JSON.parse(
    JSON.stringify(fixtures, (key, value) =>
      omitted.has(key) ? undefined : value
    )
  );
}
