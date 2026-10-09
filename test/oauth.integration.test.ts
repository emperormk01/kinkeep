import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";

const readToken = randomBytes(32).toString("base64url");
const writeToken = randomBytes(32).toString("base64url");
const clientId = "kinkeep-test-client";
const redirectUri = "https://client.example/callback";
const resource = "https://care.example/mcp";
let child: ChildProcess;
let base: string;
let port: number;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No ephemeral TCP port allocated");
  const value = address.port;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return value;
}

async function waitReady(): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(`KinKeep exited during startup (${child.exitCode})`);
    try {
      const response = await fetch(base);
      if (response.status === 404) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for KinKeep HTTP listener");
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function form(fields: Record<string, string>): URLSearchParams {
  return new URLSearchParams(fields);
}

async function authorize(fields: Record<string, string>, passphrase?: string): Promise<Response> {
  return fetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form({ ...fields, ...(passphrase !== undefined ? { passphrase } : {}) }),
    redirect: "manual",
  });
}

async function exchangeCode(fields: Record<string, string>): Promise<Response> {
  return fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form(fields) });
}

async function tokenRequest(fields: Record<string, string>): Promise<Response> {
  return fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form(fields) });
}

async function getCode(passphrase: string, scope = "kinkeep.write"): Promise<{ code: string; verifier: string }> {
  const { verifier, challenge } = pkce();
  const response = await authorize(
    { response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", scope, state: "s-1", resource },
    passphrase
  );
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location")!);
  assert.equal(location.searchParams.get("state"), "s-1");
  return { code: location.searchParams.get("code")!, verifier };
}

async function issueTokens(passphrase: string, scope = "kinkeep.write"): Promise<{ access: string; refresh: string; scope: string }> {
  const { code, verifier } = await getCode(passphrase, scope);
  const response = await exchangeCode({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: redirectUri, code_verifier: verifier, resource });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string };
  assert.equal(body.token_type, "Bearer");
  assert.ok(body.expires_in > 0);
  return { access: body.access_token, refresh: body.refresh_token, scope: body.scope };
}

function mcp(token: string, body: unknown, sessionId?: string): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
    body: JSON.stringify(body),
  });
}

function initialize(id: number) {
  return { jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "oauth-tests", version: "1" } } };
}

before(async () => {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      KINKEEP_READ_TOKEN: readToken,
      KINKEEP_WRITE_TOKEN: writeToken,
      KINKEEP_DB: `/tmp/kinkeep-oauth-test-${process.pid}.db`,
      KINKEEP_PUBLIC_ORIGIN: "https://care.example",
      KINKEEP_OAUTH_CLIENT_ID: clientId,
      KINKEEP_OAUTH_REDIRECT_URIS: redirectUri,
      KINKEEP_TEST_HOST: `127.0.0.1:${port}`,
    },
    stdio: "ignore",
  });
  await waitReady();
});

after(async () => {
  if (child?.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
});

test("publishes protected resource and authorization server metadata", async () => {
  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json() as { resource: string; authorization_servers: string[]; bearer_methods_supported: string[] };
  assert.equal(prm.resource, resource);
  assert.deepEqual(prm.authorization_servers, ["https://care.example"]);
  assert.deepEqual(prm.bearer_methods_supported, ["header"]);

  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json() as { issuer: string; code_challenge_methods_supported: string[]; grant_types_supported: string[]; registration_endpoint?: string };
  assert.equal(as.issuer, "https://care.example");
  assert.ok(as.code_challenge_methods_supported.includes("S256"));
  assert.deepEqual(as.grant_types_supported, ["authorization_code", "refresh_token"]);
  assert.equal(as.registration_endpoint, undefined); // dynamic registration is deliberately absent
});

test("unauthenticated MCP requests return 401 without a WWW-Authenticate header", async () => {
  const response = await mcp("not-a-token", initialize(1));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), null);
});

test("completes authorization-code + PKCE and the issued token drives a write session", async () => {
  const tokens = await issueTokens(writeToken, "kinkeep.write");
  assert.equal(tokens.scope, "kinkeep.write");
  const init = await mcp(tokens.access, initialize(2));
  assert.equal(init.status, 200);
  const session = init.headers.get("mcp-session-id")!;
  assert.ok(session);
  const write = await mcp(tokens.access, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "log_journal", arguments: { kind: "note", text: "issued-token write" } } }, session);
  assert.equal(write.status, 200);
  const result = (await write.json()) as { result?: { isError?: boolean } };
  assert.equal(result.result?.isError, undefined);
});

test("a read credential downgrades a write ask to read-only access", async () => {
  const tokens = await issueTokens(readToken, "kinkeep.write");
  assert.equal(tokens.scope, "kinkeep.read");
  const init = await mcp(tokens.access, initialize(4));
  assert.equal(init.status, 200);
  const session = init.headers.get("mcp-session-id")!;
  const denied = await mcp(tokens.access, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "log_journal", arguments: { kind: "note", text: "blocked" } } }, session);
  assert.equal(denied.status, 403);
});

test("rejects a wrong credential at the consent step", async () => {
  const { verifier, challenge } = pkce();
  void verifier;
  const response = await authorize(
    { response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", scope: "kinkeep.write", state: "s", resource },
    "wrong-passphrase"
  );
  assert.equal(response.status, 401);
});

test("refuses an unregistered redirect_uri instead of redirecting", async () => {
  const { challenge } = pkce();
  const response = await authorize(
    { response_type: "code", client_id: clientId, redirect_uri: "https://attacker.example/cb", code_challenge: challenge, code_challenge_method: "S256", scope: "kinkeep.write", state: "s", resource },
    writeToken
  );
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("location"), null);
});

test("rejects an authorization code replayed twice", async () => {
  const { code, verifier } = await getCode(writeToken);
  const first = await exchangeCode({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: redirectUri, code_verifier: verifier, resource });
  assert.equal(first.status, 200);
  const second = await exchangeCode({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: redirectUri, code_verifier: verifier, resource });
  assert.equal(second.status, 400);
  assert.equal(((await second.json()) as { error: string }).error, "invalid_grant");
});

test("rejects a mismatched PKCE verifier", async () => {
  const { code } = await getCode(writeToken);
  const wrongVerifier = randomBytes(32).toString("base64url");
  const response = await exchangeCode({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: redirectUri, code_verifier: wrongVerifier, resource });
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { error: string }).error, "invalid_grant");
});

test("rejects a token request whose resource is another server", async () => {
  const { code, verifier } = await getCode(writeToken);
  const response = await exchangeCode({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: redirectUri, code_verifier: verifier, resource: "https://elsewhere.example/mcp" });
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { error: string }).error, "invalid_target");
});

test("rotates refresh tokens and rejects the spent one", async () => {
  const tokens = await issueTokens(writeToken);
  const refreshed = await tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh });
  assert.equal(refreshed.status, 200);
  const rotated = (await refreshed.json()) as { access_token: string; refresh_token: string };
  assert.notEqual(rotated.refresh_token, tokens.refresh);
  const replay = await tokenRequest({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh });
  assert.equal(replay.status, 400);
  assert.equal(((await replay.json()) as { error: string }).error, "invalid_grant");
});

test("revocation immediately stops the access token", async () => {
  const tokens = await issueTokens(writeToken);
  assert.equal((await mcp(tokens.access, initialize(6))).status, 200);
  const revoked = await fetch(`${base}/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ token: tokens.access, client_id: clientId }) });
  assert.equal(revoked.status, 200);
  assert.equal((await mcp(tokens.access, initialize(7))).status, 401);
});
