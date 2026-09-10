import { setupCli } from "./setup-workflow.js";
// Preflight never escalates into execution or reads an operator key by default.
await setupCli([...process.argv.slice(2), "--plan"]);
