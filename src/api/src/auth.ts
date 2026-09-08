import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PublicKey } from "@hiero-ledger/sdk";
import { proto } from "@hiero-ledger/proto";
import { computeAddress, verifyMessage } from "ethers";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { createPool } from "@receivablex/db";

type Database = Pick<ReturnType<typeof createPool>, "query">;
export interface AuthSession { sessionId: string; accountId: string; roles: string[]; expiresAt: string }
export interface MirrorKey { _type: string; key: string }
interface AuthOptions {
  allowedOrigins?: string[];
  roleAllowlist?: Record<string, string[]>;
  fetchAccountKey?: (accountId: string) => Promise<MirrorKey>;
}
const roles = new Set(["originator", "issuer", "compliance", "servicer", "trustee", "payout_executor", "investor"]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function signedMessageBytes(message: string) {
  // Challenges contain ASCII only, keeping byte and character lengths identical across wallets.
  return Buffer.from(`\x19Hedera Signed Message:\n${Buffer.byteLength(message, "utf8")}${message}`, "utf8");
}

export function verifyHederaSignature(message: string, signatureMap: string, key: MirrorKey): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signatureMap) || signatureMap.length > 8192) return false;
  if (!["ED25519", "ECDSA_SECP256K1"].includes(key._type)) return false;
  try {
    const publicKey = key._type === "ED25519" ? PublicKey.fromStringED25519(key.key) : PublicKey.fromStringECDSA(key.key);
    const rawKey = Buffer.from(publicKey.toBytesRaw());
    const pairs = proto.SignatureMap.decode(Buffer.from(signatureMap, "base64")).sigPair;
    // Complex/threshold keys are deliberately unsupported; one complete simple-key proof is required.
    if (!pairs || pairs.length !== 1) return false;
    const pair = pairs[0]!;
    const prefix = Buffer.from(pair.pubKeyPrefix ?? []);
    if (!prefix.length || prefix.length > rawKey.length || !rawKey.subarray(0, prefix.length).equals(prefix)) return false;
    const signature = key._type === "ED25519" ? pair.ed25519 : pair.ECDSASecp256k1;
    return Boolean(signature?.length === 64 && publicKey.verify(signedMessageBytes(message), signature));
  } catch { return false; }
}

export function verifyPersonalSignature(message: string, signature: string, key: MirrorKey): boolean {
  if (key._type !== "ECDSA_SECP256K1" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  try {
    const publicKey = PublicKey.fromStringECDSA(key.key);
    const expectedAddress = computeAddress(`0x${publicKey.toStringRaw()}`);
    // The expected signer comes exclusively from the current on-chain account key.
    return verifyMessage(message, signature) === expectedAddress;
  } catch { return false; }
}

async function fetchAccountKey(accountId: string): Promise<MirrorKey> {
  const response = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/accounts/${accountId}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Account key lookup unavailable");
  const account = await response.json() as { account?: string; deleted?: boolean; key?: MirrorKey };
  if (account.account !== accountId || account.deleted || !account.key) throw new Error("Account unavailable");
  return account.key;
}

export function registerAuth(app: FastifyInstance, database: Database, options: AuthOptions = {}) {
  const allowedOrigins = new Set((options.allowedOrigins ?? (process.env.AUTH_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean)).map((value) => {
    const url = new URL(value.trim());
    if (url.origin !== value.trim() || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) throw new Error("AUTH_ALLOWED_ORIGINS must contain canonical HTTPS origins (localhost HTTP allowed)");
    return url.origin;
  }));
  const allowlist: Record<string, string[]> = options.roleAllowlist ?? JSON.parse(process.env.AUTH_ROLE_ALLOWLIST ?? "{}");
  if (!allowlist || Array.isArray(allowlist) || typeof allowlist !== "object") throw new Error("Invalid AUTH_ROLE_ALLOWLIST");
  for (const [account, assigned] of Object.entries(allowlist)) {
    if (!/^0\.0\.[1-9]\d*$/.test(account) || !Array.isArray(assigned) || assigned.some((role) => !roles.has(role))) throw new Error("Invalid account or role in AUTH_ROLE_ALLOWLIST");
  }
  const getOrigin = (request: FastifyRequest) => typeof request.headers.origin === "string" && allowedOrigins.has(request.headers.origin) ? request.headers.origin : undefined;
  const requireSession = async (request: FastifyRequest, reply: FastifyReply, requiredRole?: string): Promise<AuthSession | undefined> => {
    const origin = getOrigin(request);
    const token = request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!origin || !token) { reply.code(401).send({ error: "Sign in with your Hedera wallet." }); return; }
    const result = await database.query<{ session_id: string; account_id: string; expires_at: Date }>(
      "select session_id, account_id, expires_at from auth_sessions where token_hash = $1 and origin = $2 and revoked_at is null and expires_at > now()", [hash(token), origin],
    );
    const row = result.rows[0];
    if (!row) { reply.code(401).send({ error: "Session expired. Sign in again." }); return; }
    const assignedRoles = allowlist[row.account_id] ?? [];
    if (requiredRole && !assignedRoles.includes(requiredRole)) { reply.code(403).send({ error: `This action requires an assigned ${requiredRole} role.` }); return; }
    return { sessionId: row.session_id, accountId: row.account_id, roles: assignedRoles, expiresAt: row.expires_at.toISOString() };
  };

  app.post<{ Body: { accountId: string } }>("/api/auth/challenge", { schema: { body: { type: "object", required: ["accountId"], additionalProperties: false, properties: { accountId: { type: "string", pattern: "^0\\.0\\.[1-9][0-9]*$", maxLength: 30 } } } } }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const origin = getOrigin(request);
    if (!origin) return reply.code(403).send({ error: "This browser origin is not enabled for sign-in." });
    const requester = hash(request.ip);
    const recent = await database.query<{ count: string }>("select count(*)::text as count from auth_challenges where requester_hash = $1 and created_at > now() - interval '1 minute'", [requester]);
    if (Number(recent.rows[0]?.count ?? 0) >= 10) return reply.code(429).send({ error: "Too many sign-in attempts. Try again in one minute." });
    const challengeId = randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 5 * 60_000);
    const message = [`ReceivableX sign-in`, `Origin: ${origin}`, `Network: hedera:testnet`, `Account: ${request.body.accountId}`, `Nonce: ${randomBytes(32).toString("hex")}`, `Challenge: ${challengeId}`, `Issued at: ${issuedAt.toISOString()}`, `Expires at: ${expiresAt.toISOString()}`, `Sign to authenticate. This does not authorize a transfer.`].join("\n");
    await database.query("insert into auth_challenges (challenge_id,account_id,origin,message,requester_hash,expires_at) values ($1,$2,$3,$4,$5,$6)", [challengeId, request.body.accountId, origin, message, requester, expiresAt]);
    return { challengeId, message, expiresAt: expiresAt.toISOString() };
  });
  app.post<{ Body: { challengeId: string; signatureMap?: string; signature?: string } }>("/api/auth/verify", {
    preValidation: async (request, reply) => {
      const body = request.body;
      // Fastify's default AJV removes unknown properties. Reject them before validation.
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((name) => !["challengeId", "signatureMap", "signature"].includes(name)) || Object.hasOwn(body, "signatureMap") === Object.hasOwn(body, "signature")) {
        return reply.code(400).send({ error: "Provide challengeId and exactly one wallet proof: signatureMap or signature." });
      }
    },
    schema: { body: { type: "object", required: ["challengeId"], additionalProperties: false, oneOf: [{ required: ["signatureMap"] }, { required: ["signature"] }], properties: { challengeId: { type: "string", format: "uuid" }, signatureMap: { type: "string", minLength: 1, maxLength: 8192 }, signature: { type: "string", pattern: "^0x[0-9a-fA-F]{130}$", minLength: 132, maxLength: 132 } } } },
  }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const origin = getOrigin(request);
    if (!origin) return reply.code(403).send({ error: "This browser origin is not enabled for sign-in." });
    // Atomic consumption prevents concurrent verification/replay; a failed proof also burns the nonce.
    const consumed = await database.query<{ account_id: string; message: string }>("update auth_challenges set consumed_at = now() where challenge_id = $1 and origin = $2 and consumed_at is null and expires_at > now() returning account_id,message", [request.body.challengeId, origin]);
    const challenge = consumed.rows[0];
    if (!challenge) return reply.code(401).send({ error: "Challenge expired or already used. Request a new signature." });
    let key: MirrorKey;
    try { key = await (options.fetchAccountKey ?? fetchAccountKey)(challenge.account_id); }
    catch { return reply.code(503).send({ error: "Cannot verify the account right now. Please start sign-in again." }); }
    if (!["ED25519", "ECDSA_SECP256K1"].includes(key._type)) return reply.code(422).send({ error: "Sign-in currently supports single Ed25519 or ECDSA account keys. Threshold and contract keys are unsupported." });
    if (request.body.signature !== undefined && key._type !== "ECDSA_SECP256K1") return reply.code(422).send({ error: "MetaMask sign-in requires a Hedera account controlled by an ECDSA key. Use a native Hedera wallet for Ed25519 accounts." });
    const verified = request.body.signature !== undefined
      ? verifyPersonalSignature(challenge.message, request.body.signature, key)
      : verifyHederaSignature(challenge.message, request.body.signatureMap!, key);
    if (!verified) return reply.code(401).send({ error: "Wallet signature does not match this account and challenge." });
    const token = randomBytes(32).toString("hex");
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60_000);
    await database.query("insert into auth_sessions (session_id,token_hash,account_id,origin,expires_at) values ($1,$2,$3,$4,$5)", [sessionId, hash(token), challenge.account_id, origin, expiresAt]);
    return { token, sessionId, accountId: challenge.account_id, roles: allowlist[challenge.account_id] ?? [], expiresAt: expiresAt.toISOString() };
  });
  app.get("/api/auth/me", async (request, reply) => { reply.header("cache-control", "no-store"); return requireSession(request, reply); });
  app.post("/api/auth/logout", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    await database.query("update auth_sessions set revoked_at = now() where session_id = $1", [session.sessionId]);
    return { signedOut: true };
  });
  return requireSession;
}
