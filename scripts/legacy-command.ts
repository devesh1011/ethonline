export function retiredCommand(command: string): void {
  console.log(JSON.stringify({ status: "RETIRED_ENTRYPOINT", command, executed: false, replacement: "npm run testnet:setup -- --resume --run-id <run-id> --plan", reason: "Use the resumable setup journal with its explicit testnet key-risk acknowledgement. This legacy command does not load keys or submit transactions." }, null, 2));
  if (process.argv.includes("--execute")) { console.error("Legacy execution is disabled. Review the resumable plan and its explicit secured-key or exposed-testnet-key acknowledgement."); process.exitCode = 1; }
}
