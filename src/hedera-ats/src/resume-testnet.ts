import { safeRehearsalCli } from "../../../scripts/setup-rehearsal.js";
// Resume from durable operation identities, never a handmade ats-progress file.
await safeRehearsalCli(process.argv.slice(2), "ATS_ISSUANCE_RESUME");
