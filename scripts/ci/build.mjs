import { run } from "./process.mjs";
await run("npm", ["run", "build", "--workspace", "@receivablex/domain"]);
await run("npm", ["exec", "--workspace", "@receivablex/contracts", "--", "hardhat", "--config", "hardhat.local.config.ts", "compile"]);
for (const name of ["db", "hedera-ats", "hedera-native", "api", "worker", "web"]) await run("npm", ["run", "build", "--workspace", `@receivablex/${name}`]);
