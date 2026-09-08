import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { PrivateKey } from "@hiero-ledger/sdk";
import { proto } from "@hiero-ledger/proto";
import { createPool } from "@receivablex/db";
import { Wallet } from "ethers";
import { registerAuth, signedMessageBytes, verifyHederaSignature, verifyPersonalSignature } from "./auth.js";

function signature(privateKey: PrivateKey, message: string, ecdsa = false) {
  const bytes = privateKey.sign(signedMessageBytes(message));
  return Buffer.from(proto.SignatureMap.encode({ sigPair: [{ pubKeyPrefix: privateKey.publicKey.toBytesRaw(), ...(ecdsa ? { ECDSASecp256k1: bytes } : { ed25519: bytes }) }] }).finish()).toString("base64");
}
test("native Ed25519/ECDSA proofs verify only the bound challenge and correct account key", () => {
  for (const ecdsa of [false, true]) {
    const key = ecdsa ? PrivateKey.generateECDSA() : PrivateKey.generateED25519();
    const mirrorKey = { _type: ecdsa ? "ECDSA_SECP256K1" : "ED25519", key: key.publicKey.toStringRaw() };
    const proof = signature(key, "Origin: https://example.test\nAccount: 0.0.123", ecdsa);
    assert.equal(verifyHederaSignature("Origin: https://example.test\nAccount: 0.0.123", proof, mirrorKey), true);
    assert.equal(verifyHederaSignature("Origin: https://attacker.test\nAccount: 0.0.123", proof, mirrorKey), false);
    assert.equal(verifyHederaSignature("other account", proof, mirrorKey), false);
    assert.equal(verifyHederaSignature("Origin: https://example.test\nAccount: 0.0.123", proof, { ...mirrorKey, key: (ecdsa ? PrivateKey.generateECDSA() : PrivateKey.generateED25519()).publicKey.toStringRaw() }), false);
    assert.equal(verifyHederaSignature("anything", "not valid base64!", mirrorKey), false);
    assert.equal(verifyHederaSignature("anything", proof, { _type: "ProtobufEncoded", key: "threshold" }), false);
  }
});

test("personal_sign recovers the actual ECDSA account key and rejects changed message, signer, and key type", async () => {
  const key = PrivateKey.generateECDSA();
  const wallet = new Wallet(`0x${key.toStringRaw()}`);
  const mirrorKey = { _type: "ECDSA_SECP256K1", key: key.publicKey.toStringRaw() };
  const message = "Origin: https://example.test\nNetwork: hedera:testnet\nAccount: 0.0.123\nNonce: test";
  const proof = await wallet.signMessage(message);
  assert.equal(verifyPersonalSignature(message, proof, mirrorKey), true);
  assert.equal(verifyPersonalSignature(message.replace("example.test", "attacker.test"), proof, mirrorKey), false);
  assert.equal(verifyPersonalSignature(message.replace("0.0.123", "0.0.456"), proof, mirrorKey), false);
  assert.equal(verifyPersonalSignature(message.replace("testnet", "mainnet"), proof, mirrorKey), false);
  assert.equal(verifyPersonalSignature(message, await Wallet.createRandom().signMessage(message), mirrorKey), false);
  assert.equal(verifyPersonalSignature(message, proof, { ...mirrorKey, key: PrivateKey.generateECDSA().publicKey.toStringRaw() }), false);
  assert.equal(verifyPersonalSignature(message, proof, { _type: "ED25519", key: PrivateKey.generateED25519().publicKey.toStringRaw() }), false);
  assert.equal(verifyPersonalSignature(message, proof, { _type: "ProtobufEncoded", key: "threshold" }), false);
  assert.equal(verifyPersonalSignature(message, proof.slice(2), mirrorKey), false);
  assert.equal(verifyPersonalSignature(message, "0x1234", mirrorKey), false);
});

test("personal_sign API enforces exactly one proof, preserves nonce rules, and keeps explicit roles", async () => {
  const database = createPool();
  const connection = await database.connect();
  const schema = `auth_evm_test_${randomUUID().replaceAll("-", "")}`;
  const app = Fastify();
  try {
    await connection.query(`create schema ${schema}`);
    await connection.query(`set search_path to ${schema}`);
    await connection.query(await readFile(new URL("../../db/migrations/003_auth.sql", import.meta.url), "utf8"));
    const key = PrivateKey.generateECDSA();
    const wallet = new Wallet(`0x${key.toStringRaw()}`);
    const ed25519 = PrivateKey.generateED25519();
    registerAuth(app, connection, { allowedOrigins: ["https://example.test"], roleAllowlist: { "0.0.123": ["servicer"] }, fetchAccountKey: async (account) => account === "0.0.789" ? { _type: "ED25519", key: ed25519.publicKey.toStringRaw() } : { _type: "ECDSA_SECP256K1", key: key.publicKey.toStringRaw() } });
    const headers = { origin: "https://example.test" };
    const challenge = async (accountId = "0.0.123") => {
      const response = await app.inject({ method: "POST", url: "/api/auth/challenge", headers, payload: { accountId } });
      assert.equal(response.statusCode, 200);
      return response.json<{ challengeId: string; message: string }>();
    };
    const verify = (payload: object) => app.inject({ method: "POST", url: "/api/auth/verify", headers, payload });
    const bound = await challenge();
    const proof = await wallet.signMessage(bound.message);
    for (const payload of [
      { challengeId: bound.challengeId },
      { challengeId: bound.challengeId, signature: proof, signatureMap: signature(key, bound.message, true) },
      { challengeId: bound.challengeId, signature: proof, address: wallet.address },
      { challengeId: bound.challengeId, signature: proof, arbitrary: true },
      { challengeId: bound.challengeId, signature: proof.slice(2) },
      { challengeId: bound.challengeId, signature: "0x1234" },
      { challengeId: bound.challengeId, signature: null },
      { signature: proof },
    ]) assert.equal((await verify(payload)).statusCode, 400);
    const approved = await verify({ challengeId: bound.challengeId, signature: proof });
    assert.equal(approved.statusCode, 200);
    assert.deepEqual(approved.json().roles, ["servicer"]);
    assert.equal((await verify({ challengeId: bound.challengeId, signature: proof })).statusCode, 401);
    const visitor = await challenge("0.0.456");
    const visitorResponse = await verify({ challengeId: visitor.challengeId, signature: await wallet.signMessage(visitor.message) });
    assert.equal(visitorResponse.statusCode, 200);
    assert.deepEqual(visitorResponse.json().roles, []);
    for (const replacement of ["wrong-signer", "domain", "account"]) {
      const value = await challenge();
      const message = replacement === "domain" ? value.message.replace("example.test", "attacker.test") : replacement === "account" ? value.message.replace("0.0.123", "0.0.456") : value.message;
      const signer = replacement === "wrong-signer" ? Wallet.createRandom() : wallet;
      assert.equal((await verify({ challengeId: value.challengeId, signature: await signer.signMessage(message) })).statusCode, 401);
      assert.equal((await verify({ challengeId: value.challengeId, signature: await wallet.signMessage(value.message) })).statusCode, 401);
    }
    const ed = await challenge("0.0.789");
    assert.equal((await verify({ challengeId: ed.challengeId, signature: await wallet.signMessage(ed.message) })).statusCode, 422);
    const expired = await challenge();
    await connection.query("update auth_challenges set created_at = now() - interval '10 minutes', expires_at = now() - interval '1 minute' where challenge_id = $1", [expired.challengeId]);
    assert.equal((await verify({ challengeId: expired.challengeId, signature: await wallet.signMessage(expired.message) })).statusCode, 401);
  } finally {
    await app.close();
    await connection.query("set search_path to public");
    await connection.query(`drop schema if exists ${schema} cascade`);
    connection.release();
    await database.end();
  }
});

test("durable auth rejects origin, signature, replay, expiry and missing roles; revokes sessions", async () => {
  const database = createPool();
  const connection = await database.connect();
  const schema = `auth_test_${randomUUID().replaceAll("-", "")}`;
  const app = Fastify();
  try {
    await connection.query(`create schema ${schema}`);
    await connection.query(`set search_path to ${schema}`);
    await connection.query(await readFile(new URL("../../db/migrations/003_auth.sql", import.meta.url), "utf8"));
    const key = PrivateKey.generateED25519();
    const requireSession = registerAuth(app, connection, { allowedOrigins: ["https://example.test"], roleAllowlist: { "0.0.123": ["servicer"] }, fetchAccountKey: async () => ({ _type: "ED25519", key: key.publicKey.toStringRaw() }) });
    app.post("/restricted", async (request, reply) => { const session = await requireSession(request, reply, "servicer"); return session ? { account: session.accountId } : undefined; });
    const headers = { origin: "https://example.test" };
    const challenge = async (accountId = "0.0.123") => {
      const response = await app.inject({ method: "POST", url: "/api/auth/challenge", headers, payload: { accountId } });
      assert.equal(response.statusCode, 200);
      return response.json<{ challengeId: string; message: string }>();
    };
    const verify = (value: { challengeId: string; message: string }) => app.inject({ method: "POST", url: "/api/auth/verify", headers, payload: { challengeId: value.challengeId, signatureMap: signature(key, value.message) } });
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/challenge", headers: { origin: "https://attacker.test" }, payload: { accountId: "0.0.123" } })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: "/restricted", headers })).statusCode, 401);
    const bound = await challenge();
    assert.match(bound.message, /Network: hedera:testnet/);
    assert.match(bound.message, /Origin: https:\/\/example.test/);
    const approved = await verify(bound);
    assert.equal(approved.statusCode, 200);
    const { token } = approved.json<{ token: string }>();
    assert.equal((await verify(bound)).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/restricted", headers: { ...headers, authorization: `Bearer ${token}` } })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/auth/me", headers: { origin: "https://attacker.test", authorization: `Bearer ${token}` } })).statusCode, 401);
    const visitor = await verify(await challenge("0.0.456"));
    assert.deepEqual(visitor.json().roles, []);
    assert.equal((await app.inject({ method: "POST", url: "/restricted", headers: { ...headers, authorization: `Bearer ${visitor.json().token}` } })).statusCode, 403);
    const expired = await challenge();
    await connection.query("update auth_challenges set created_at = now() - interval '10 minutes', expires_at = now() - interval '1 minute' where challenge_id = $1", [expired.challengeId]);
    assert.equal((await verify(expired)).statusCode, 401);
    const wrong = await challenge();
    assert.equal((await verify({ ...wrong, message: "modified" })).statusCode, 401);
    assert.equal((await verify(wrong)).statusCode, 401);
    const concurrent = await challenge();
    assert.deepEqual((await Promise.all([verify(concurrent), verify(concurrent)])).map((response) => response.statusCode).sort(), [200, 401]);
    const stored = await connection.query<{ token_hash: string }>("select token_hash from auth_sessions");
    assert.equal(stored.rows.some((row) => row.token_hash === token), false);
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/logout", headers: { ...headers, authorization: `Bearer ${token}` } })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/auth/me", headers: { ...headers, authorization: `Bearer ${token}` } })).statusCode, 401);
  } finally {
    await app.close();
    await connection.query("set search_path to public");
    await connection.query(`drop schema if exists ${schema} cascade`);
    connection.release();
    await database.end();
  }
});
