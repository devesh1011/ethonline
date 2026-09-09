import { operationArguments, operationsRequest } from "./operation-client.js";
import { sanitizeError } from "@receivablex/domain";
try {
  const options = operationArguments();
  if (options.help || options.plan) console.log("Read-only: operation-inspect.ts [--api ORIGIN] [--operation ID]. Uses OPS_AUTH_TOKEN_FILE or OPS_AUTH_TOKEN; never loads a signer.");
  else console.log(JSON.stringify(await operationsRequest(options.base, options.operationId ? `/api/ops/operations/${options.operationId}` : "/api/ops"), null, 2));
} catch (error) { console.error(sanitizeError(error)); process.exitCode = 1; }
