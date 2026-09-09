import { operationArguments, operationsRequest } from "./operation-client.js";
import { sanitizeError } from "@receivablex/domain";
try {
  const options = operationArguments();
  if (!options.operationId || !options.transactionId || options.help) console.log("Usage: operation-reconcile.ts --operation ID --transaction ORIGINAL_ID [--execute]. Default is a plan; execution only records an original receipt observation, never a submission.");
  else if (!options.execute) console.log(JSON.stringify({ mode: "PLAN", operationId: options.operationId, transactionId: options.transactionId, action: "Inspect journal identity, then record a read-only receipt observation", signs: false, submits: false, replacesNonce: false }, null, 2));
  else {
    const operation = await operationsRequest(options.base, `/api/ops/operations/${options.operationId}`) as { steps: { transactionId: string | null }[] };
    if (!operation.steps.some(step => step.transactionId === options.transactionId)) throw new Error("Original transaction is not present in the operation journal");
    console.log(JSON.stringify(await operationsRequest(options.base, `/api/ops/operations/${options.operationId}/reconcile`, { transactionId: options.transactionId }), null, 2));
  }
} catch (error) { console.error(sanitizeError(error)); process.exitCode = 1; }
