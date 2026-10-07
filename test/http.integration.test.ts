import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

const readToken = randomBytes(32).toString("base64url");
const writeToken = randomBytes(32).toString("base64url");
let child: ChildProcess;
let base: string;
let port: number;
let writeSession: string;
let readSession: string;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No ephemeral TCP port allocated");
  const value = address.port;
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
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

function auth(token = writeToken): HeadersInit {
  return { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
}

async function post(body: unknown, token?: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/mcp`, { method: "POST", headers: { ...(token ? auth(token) as Record<string, string> : { "content-type": "application/json" }), ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}

function initialize(id: number) {
  return { jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "security-tests", version: "1" } } };
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
      KINKEEP_DB: `/tmp/kinkeep-http-test-${process.pid}.db`,
      KINKEEP_MAX_BODY_BYTES: "1024",
      KINKEEP_MAX_SESSIONS: "3",
      KINKEEP_SESSION_TTL_MS: "60000",
      KINKEEP_PUBLIC_ORIGIN: `https://canonical.example`,
      KINKEEP_ORIGINS: "https://trusted.example",
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

test("denies absent and incorrect bearer tokens before MCP parsing", async () => {
  assert.equal((await post("{}" )).status, 401);
  assert.equal((await post("{}", randomBytes(32).toString("base64url"))).status, 401);
});

test("read credentials cannot invoke any write tool", async () => {
  const writeTools = ["add_appointment", "complete_appointment", "log_medication", "add_reminder", "complete_reminder", "log_journal"];
  for (const name of writeTools) {
    const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }, readToken);
    assert.equal(response.status, 403, `${name} should be denied to read token`);
  }
  const readCall = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "who_can_help", arguments: {} } }, readToken);
  assert.equal(readCall.status, 403, "unknown MCP sessions are rejected before dispatch");
});

test("write credentials initialize and read/write credentials are required on each request", async () => {
const urlForTest = `http://127.0.0.1:${port}`;
  const response = await fetch(`${urlForTest}/mcp`, { method: "POST", headers: { ...auth(writeToken) as Record<string, string> }, body: JSON.stringify(initialize(1)) });
  assert.equal(response.status, 200);
  writeSession = response.headers.get("mcp-session-id")!;
  const session = writeSession;
  const tools = await fetch(`${base}/mcp`, { method: "POST", headers: { ...auth(readToken) as Record<string, string>, "mcp-session-id": session! }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) });
  assert.equal(tools.status, 200);
  const writeDenied = await fetch(`${base}/mcp`, { method: "POST", headers: { ...auth(writeToken) as Record<string, string>, "mcp-session-id": session! }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "log_journal", arguments: { kind: "note", text: "blocked write" } } }) });
  assert.equal(writeDenied.status, 200);
  const writeResult = await writeDenied.json() as { result?: { isError?: boolean } };
  assert.equal(writeResult.result?.isError, undefined);
});

test("enforces request-size and active-session limits", async () => {
const readInit = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: auth(readToken), body: JSON.stringify(initialize(20)) });
  assert.equal(readInit.status, 200);
  readSession = readInit.headers.get("mcp-session-id")!;
  const writeInit = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: auth(writeToken), body: JSON.stringify(initialize(21)) });
  assert.equal(writeInit.status, 200);
  writeSession = writeInit.headers.get("mcp-session-id")!;
  const tooLarge = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { ...auth(writeToken) as Record<string, string>, "mcp-session-id": writeSession }, body: "x".repeat(1100) }).catch(() => null);
  assert.equal(tooLarge?.status ?? 413, 413);
  const bodyLimit = await fetch(`${base}/mcp`, { method: "POST", headers: { ...auth(writeToken) as Record<string, string>, "mcp-session-id": writeSession }, body: JSON.stringify({ jsonrpc: "2.0", id: 43, method: "tools/call", params: { name: "log_journal", arguments: { kind: "note", text: "x".repeat(2000) } } }) });
  assert.equal(bodyLimit.status, 413);
  const thirdSession = await post(initialize(4), writeToken);
  assert.equal(thirdSession.status, 503);
  const blockedReadSessionWrite = await fetch(`${base}/mcp`, { method: "POST", headers: { ...auth(writeToken) as Record<string, string>, "mcp-session-id": readSession }, body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "log_journal", arguments: { kind: "note", text: "should be blocked" } } }) });
  assert.equal(blockedReadSessionWrite.status, 403);
});

test("rejects unexpected Host values for MCP requests", async () => {
  const response = await fetch(`${base}/mcp`, { method: "POST", headers: { ...auth(writeToken) as Record<string, string>, host: "attacker.example" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping", params: {} }) });
  assert.equal(response.status, 403);
});

test("rejects hostile Origin and does not expose OAuth discovery", async () => {
  const badOrigin = await fetch(`http://localhost:${port}/mcp`, { method: "POST", headers: { ...auth(writeToken) as Record<string, string>, origin: "https://attacker.example" }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping", params: {} }) });
  assert.equal(badOrigin.status, 403);
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"]) {
    const response = await fetch(`${base}${path}`, { headers: { host: "attacker.example" } });
    assert.equal(response.status, 404);
    const data = await response.json() as { issuer?: string; resource?: string };
    assert.equal(data.issuer, undefined);
    assert.equal(data.resource, undefined);
  }
});
