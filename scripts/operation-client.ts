import { lstat, readFile } from "node:fs/promises";
import { sanitizeError, sanitizedRequest } from "@receivablex/domain";

export function operationArguments(args = process.argv.slice(2)) {
  const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  const base = value("--api") ?? process.env.OPS_API_URL ?? "http://127.0.0.1:3001";
  let url: URL;
  try { url = new URL(base); if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || !(url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("invalid"); }
  catch { throw new Error("Use an HTTPS API origin or a local HTTP origin without credentials or query parameters"); }
  const operationId = value("--operation"), transactionId = value("--transaction");
  if (operationId && !/^[A-Za-z0-9-]{1,100}$/.test(operationId)) throw new Error("Invalid operation identity");
  return { base: url.origin, operationId, transactionId, execute: args.includes("--execute"), plan: args.includes("--plan"), help: args.includes("--help") };
}
async function token() {
  let value = process.env.OPS_AUTH_TOKEN;
  const file = process.env.OPS_AUTH_TOKEN_FILE;
  if (value && file) throw new Error("Configure one operations token source");
  if (file) {
    try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > 256) throw new Error("unsafe"); value = (await readFile(file, "utf8")).trim(); }
    catch { throw new Error("Operations token file must be an owner-private regular file"); }
  }
  if (!value || !/^[a-f0-9]{64}$/.test(value)) throw new Error("An authenticated operations session token is required");
  return value;
}
export async function operationsRequest(base: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${await token()}`, origin: process.env.OPS_BROWSER_ORIGIN ?? "http://localhost:3000", ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(sanitizeError(result.error ?? "Operations request failed"));
  return sanitizedRequest(result);
}
