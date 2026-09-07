// Legacy direct deployment is retired; importing this file never loads credentials.
console.log(JSON.stringify({ status: "RETIRED_ENTRYPOINT", executed: false, replacement: "npm run testnet:setup -- --resume --run-id <run-id> --plan" }, null, 2));
if (process.argv.includes("--execute")) { console.error("Use the resumable setup coordinator with its explicit testnet key-risk acknowledgement."); process.exitCode = 1; }
