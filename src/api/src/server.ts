import { createPool } from "@receivablex/db";
import { buildApp } from "./app.js";
import { sanitizeError } from "@receivablex/domain";

const database = createPool();
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let closing = false;
const close = async () => {
  if (closing) return; closing = true;
  await app?.close();
  await database.end();
};
process.on("SIGINT", () => { void close().catch(() => console.error("API shutdown failed")); });
process.on("SIGTERM", () => { void close().catch(() => console.error("API shutdown failed")); });
try {
  app = await buildApp(database);
  const raw = process.env.PORT ?? "3001", host = process.env.HOST ?? "0.0.0.0";
  if (!/^\d{1,5}$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535 || !/^[A-Za-z0-9:._-]{1,253}$/.test(host)) throw new Error("Invalid API host or port configuration");
  await app.listen({ host, port: Number(raw) });
} catch (error) { console.error(sanitizeError(error)); await close(); process.exitCode = 1; }
