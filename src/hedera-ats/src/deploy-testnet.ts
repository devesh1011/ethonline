import { safeRehearsalCli } from "../../../scripts/setup-rehearsal.js";
// ATS deployment now belongs to the approved-draft durable API/worker workflow.
// This compatibility entry point plans or verifies it; it cannot bypass review.
await safeRehearsalCli(process.argv.slice(2), "ATS_ISSUANCE");
