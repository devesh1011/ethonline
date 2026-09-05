import { createPool } from "./index.js";
import { migrateDatabase } from "./migration-runner.js";
const database = createPool();
try { const result = await migrateDatabase(database); for (const version of result.applied) console.log(`Applied ${version} in ${result.schema}`); }
catch { console.error("Migration failed; previous committed migrations are preserved. Review the migration and configured schema before retrying."); process.exitCode = 1; }
finally { await database.end(); }
