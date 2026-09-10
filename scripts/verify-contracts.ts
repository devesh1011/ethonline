import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { SetupStore } from "./setup-checkpoints.js";
import { checkVerificationStatus, runContractVerification, verificationArguments, type VerificationSubmission } from "./contract-verification.js";

export async function main(args = process.argv.slice(2)) {
  const options = verificationArguments(args);
  if (!options.execute && !options.check) {
    console.log(JSON.stringify({ mode: "PLAN", command: "npm run contracts:verify -- --run-id RUN --execute [--target registry|payout|all]", target: options.target, publication: false, notes: ["Uses confirmed identities from the selected run, never historical evidence", "Matches exact artifact creation/runtime bytecode against build-info and testnet runtime", "Registry can be submitted before payout exists; pending payout is not verified", "Sourcify submission is not completed verification; retain the job and check its result"] }, null, 2));
    return;
  }
  const store = await SetupStore.resume(resolve(".local/runs"), options.runId!);
  if (options.check) {
    const file = options.reportFile ?? (await readdir(store.directory)).filter(name => /^verification-\d{13}-[a-f0-9]{8}\.json$/.test(name)).sort().at(-1);
    if (!file) throw new Error("No original verification submission report exists");
    const original = await store.get<VerificationSubmission>(file), deadline = Date.now() + options.waitSeconds * 1000;
    let report = await checkVerificationStatus(original, options.runId!);
    while (report.results.some(result => !result.jobCompleted) && Date.now() + 5000 <= deadline) { await new Promise(resolve => setTimeout(resolve, 5000)); report = await checkVerificationStatus(original, options.runId!); }
    const resultFile = `verification-check-${Date.now()}-${randomUUID().slice(0, 8)}.json`;
    await store.put(resultFile, { ...report, sourceReport: file });
    console.log(JSON.stringify({ ...report, sourceReport: file, reportFile: resultFile }, null, 2));
    return;
  }
  const report = await runContractVerification(store, new URL("../src/contracts/artifacts/", import.meta.url), options.target);
  const file = `verification-${Date.now()}-${randomUUID().slice(0, 8)}.json`;
  await store.put(file, report);
  console.log(JSON.stringify({ ...report, reportFile: file }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(() => { console.error("Verification stopped: check the selected run, confirmed creation receipt, exact artifact/build-info and public verification service. Historical evidence was not modified."); process.exitCode = 1; });
