// Embedded OAuth 2.1 authorization server for KinKeep.
//
// The MCP server is also its own authorization server: there is no external
// identity provider. Account linking uses the authorization-code grant with
// PKCE (S256). No dynamic client registration: a single public client is
// configured through the environment. Tokens and codes are stored as SHA-256
// hashes in SQLite, so a database copy does not leak live credentials.
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { KinKeepDb } from "./db.js";
import { bearerToken, timingSafeStringEqual } from "./security.js";

export const READ_SCOPE = "kinkeep.read";
export const WRITE_SCOPE = "kinkeep.write";
const SUPPORTED_SCOPES = [READ_SCOPE, WRITE_SCOPE];

export interface OAuthConfig {
  origin: string; // issuer identifier, canonical origin with no trailing slash
  resource: string; // canonical MCP endpoint, e.g. https://care.example/mcp
  clientId: string | null;
  redirectUris: string[];
  readToken: string;
  writeToken: string;
  accessTtlMs: number;
  refreshTtlMs: number;
  codeTtlMs: number;
  maxBodyBytes: number;
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function oauthConfig(origin: string, readToken: string, writeToken: string, maxBodyBytes: number): OAuthConfig {
  const id = process.env.KINKEEP_OAUTH_CLIENT_ID?.trim();
  return {
    origin,
    resource: `${origin}/mcp`,
    clientId: id ? id : null,
    redirectUris: (process.env.KINKEEP_OAUTH_REDIRECT_URIS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    readToken,
    writeToken,
    accessTtlMs: positiveIntEnv("KINKEEP_ACCESS_TOKEN_TTL_MS", 60 * 60 * 1000),
    refreshTtlMs: positiveIntEnv("KINKEEP_REFRESH_TOKEN_TTL_MS", 30 * 24 * 60 * 60 * 1000),
    codeTtlMs: positiveIntEnv("KINKEEP_AUTH_CODE_TTL_MS", 60 * 1000),
    maxBodyBytes,
  };
}

export function protectedResourceMetadata(config: OAuthConfig) {
  return {
    resource: config.resource,
    authorization_servers: [config.origin],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "KinKeep",
  };
}

export function authorizationServerMetadata(config: OAuthConfig) {
  return {
    issuer: config.origin,
    authorization_endpoint: `${config.origin}/oauth/authorize`,
    token_endpoint: `${config.origin}/oauth/token`,
    revocation_endpoint: `${config.origin}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [...SUPPORTED_SCOPES],
  };
}

const hashSecret = (value: string) => createHash("sha256").update(value).digest("hex");
const newSecret = () => randomBytes(32).toString("base64url");

// Resolve an issued access token to a role. Static read/write tokens are checked
// separately in server.ts; this only knows about tokens the OAuth flow issued.
export function resolveOAuthAccess(db: KinKeepDb, header: string | undefined): "read" | "write" | null {
  const token = bearerToken(header);
  if (!token) return null;
  const row = db.findOAuthToken(hashSecret(token));
  if (!row || row.kind !== "access" || row.revoked || row.expires_at <= Date.now()) return null;
  return row.scope.split(/\s+/).includes(WRITE_SCOPE) ? "write" : "read";
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function oauthError(res: ServerResponse, status: number, error: string, description: string) {
  json(res, status, { error, error_description: description });
}

function html(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

async function readForm(req: IncomingMessage, limit: number): Promise<URLSearchParams | null> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk.toString();
    if (Buffer.byteLength(raw) > limit) return null;
  }
  return new URLSearchParams(raw);
}

const validPkceValue = (value: string) => /^[A-Za-z0-9._~-]{43,128}$/.test(value);

function verifyPkce(verifier: string, challenge: string): boolean {
  return createHash("sha256").update(verifier).digest("base64url") === challenge;
}

interface AuthorizeParams {
  clientId: string | null;
  redirectUri: string | null;
  responseType: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  scope: string;
  state: string | null;
  resource: string | null;
}

function authorizeParams(params: URLSearchParams): AuthorizeParams {
  return {
    clientId: params.get("client_id"),
    redirectUri: params.get("redirect_uri"),
    responseType: params.get("response_type"),
    codeChallenge: params.get("code_challenge"),
    codeChallengeMethod: params.get("code_challenge_method"),
    scope: (params.get("scope") ?? "").trim(),
    state: params.get("state"),
    resource: params.get("resource"),
  };
}

function redirectWithError(res: ServerResponse, redirectUri: string, error: string, description: string, state: string | null) {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  target.searchParams.set("error_description", description);
  if (state !== null) target.searchParams.set("state", state);
  res.writeHead(302, { location: target.href, "cache-control": "no-store" });
  res.end();
}

function consentPage(config: OAuthConfig, p: AuthorizeParams, message: string | null): string {
  const hidden = (name: string, value: string | null) =>
    value === null ? "" : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  const requested = p.scope || WRITE_SCOPE;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to KinKeep</title>
<style>body{margin:0;background:#e8e5dc;color:#252923;font:16px/1.6 system-ui,sans-serif}
main{max-width:34rem;margin:8vh auto;padding:28px;background:#f2f0e9;border:1px solid #8c9984}
h1{font:400 1.7rem/1.2 Georgia,serif;margin:0 0 6px}p{color:#4e594d}
code{font-family:ui-monospace,Menlo,monospace;font-size:.85em;overflow-wrap:anywhere}
label{display:block;margin:22px 0 6px;font-weight:600;font-size:.8rem;letter-spacing:.06em;text-transform:uppercase}
input[type=password]{width:100%;box-sizing:border-box;padding:12px;border:1px solid #8c9984;background:#fff;font:inherit}
button{margin-top:18px;width:100%;min-height:46px;border:0;background:#315b46;color:#f2f0e9;font:600 1rem/1 system-ui,sans-serif;cursor:pointer}
.error{margin-top:16px;padding:10px 12px;border-left:3px solid #b85e37;background:#f6e7de;color:#7a3c22}</style></head>
<body><main>
<h1>Connect a client to KinKeep</h1>
<p><code>${escapeHtml(p.clientId ?? "")}</code> wants access to this household's care notebook, and will be sent back to <code>${escapeHtml(p.redirectUri ?? "")}</code>.</p>
<p>It is asking for <strong>${escapeHtml(requested)}</strong>. Enter the household credential to approve. The write credential also grants read; the read credential grants read only.</p>
<form method="post" action="/oauth/authorize">
${hidden("client_id", p.clientId)}
${hidden("redirect_uri", p.redirectUri)}
${hidden("response_type", p.responseType)}
${hidden("code_challenge", p.codeChallenge)}
${hidden("code_challenge_method", p.codeChallengeMethod)}
${hidden("scope", p.scope)}
${hidden("state", p.state)}
${hidden("resource", p.resource)}
<label for="passphrase">Household credential</label>
<input id="passphrase" name="passphrase" type="password" autocomplete="off" required>
<button type="submit">Approve access</button>
</form>
${message ? `<p class="error">${escapeHtml(message)}</p>` : ""}
</main></body></html>`;
}

function authorizeErrorPage(res: ServerResponse, status: number, message: string) {
  html(res, status, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>KinKeep</title></head>
<body style="font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:8vh auto;padding:0 24px">
<h1 style="font:400 1.6rem/1.2 Georgia,serif">Cannot continue</h1><p>${escapeHtml(message)}</p></body></html>`);
}

// Validate everything except the human approval. Returns null when valid.
function validateAuthorize(config: OAuthConfig, p: AuthorizeParams): { error: string; description: string } | null {
  if (!config.clientId) return { error: "unauthorized_client", description: "No OAuth client is registered on this server." };
  if (p.clientId !== config.clientId) return { error: "unauthorized_client", description: "Unknown client_id." };
  if (!p.redirectUri || !config.redirectUris.includes(p.redirectUri)) return { error: "invalid_request", description: "redirect_uri is not registered." };
  if (p.responseType !== "code") return { error: "unsupported_response_type", description: "Only response_type=code is supported." };
  if (p.codeChallengeMethod !== "S256") return { error: "invalid_request", description: "code_challenge_method must be S256." };
  if (!p.codeChallenge || !validPkceValue(p.codeChallenge)) return { error: "invalid_request", description: "code_challenge is missing or malformed." };
  if (p.resource !== null && p.resource !== config.resource) return { error: "invalid_target", description: "resource does not match this server." };
  const requested = p.scope ? p.scope.split(/\s+/) : [WRITE_SCOPE];
  if (!requested.every((s) => SUPPORTED_SCOPES.includes(s))) return { error: "invalid_scope", description: "Requested scope is not supported." };
  return null;
}

async function handleAuthorize(req: IncomingMessage, res: ServerResponse, url: URL, config: OAuthConfig, db: KinKeepDb) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.writeHead(405, { allow: "GET, POST" });
    res.end();
    return;
  }
  // The POST body is the request stream; read it once and derive everything from it.
  const body = req.method === "POST" ? await readForm(req, config.maxBodyBytes) : null;
  if (req.method === "POST" && !body) {
    authorizeErrorPage(res, 400, "Request body is missing or too large.");
    return;
  }
  const p = req.method === "POST" ? authorizeParams(body!) : authorizeParams(url.searchParams);
  const invalid = validateAuthorize(config, p);
  if (invalid) {
    // client_id and redirect_uri are untrusted here, so never redirect the error.
    if (invalid.error === "unauthorized_client" || invalid.error === "invalid_request") {
      authorizeErrorPage(res, 400, invalid.description);
    } else {
      redirectWithError(res, p.redirectUri!, invalid.error, invalid.description, p.state);
    }
    return;
  }
  if (req.method === "GET") {
    html(res, 200, consentPage(config, p, null));
    return;
  }
  const passphrase = body!.get("passphrase") ?? "";
  const isWrite = timingSafeStringEqual(passphrase, config.writeToken);
  const isRead = !isWrite && timingSafeStringEqual(passphrase, config.readToken);
  if (!isWrite && !isRead) {
    html(res, 401, consentPage(config, p, "That credential was not recognised."));
    return;
  }
  // The credential caps the grant: a read credential downgrades a write ask.
  const requested = p.scope ? p.scope.split(/\s+/) : [WRITE_SCOPE];
  const granted = isWrite ? (requested.includes(WRITE_SCOPE) ? WRITE_SCOPE : READ_SCOPE) : READ_SCOPE;

  const code = newSecret();
  db.storeAuthCode({
    code_hash: hashSecret(code),
    client_id: p.clientId!,
    redirect_uri: p.redirectUri!,
    code_challenge: p.codeChallenge!,
    code_challenge_method: "S256",
    scope: granted,
    resource: p.resource,
    expires_at: Date.now() + config.codeTtlMs,
    used: 0,
  });
  const target = new URL(p.redirectUri!);
  target.searchParams.set("code", code);
  if (p.state !== null) target.searchParams.set("state", p.state);
  res.writeHead(302, { location: target.href, "cache-control": "no-store" });
  res.end();
}

function issueTokens(config: OAuthConfig, db: KinKeepDb, clientId: string, scope: string, resource: string | null) {
  const now = Date.now();
  const access = newSecret();
  const refresh = newSecret();
  db.storeOAuthToken({ token_hash: hashSecret(access), kind: "access", client_id: clientId, scope, resource, expires_at: now + config.accessTtlMs, created_at: now, revoked: 0 });
  db.storeOAuthToken({ token_hash: hashSecret(refresh), kind: "refresh", client_id: clientId, scope, resource, expires_at: now + config.refreshTtlMs, created_at: now, revoked: 0 });
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: Math.floor(config.accessTtlMs / 1000),
    refresh_token: refresh,
    scope,
  };
}

async function handleToken(req: IncomingMessage, res: ServerResponse, config: OAuthConfig, db: KinKeepDb) {
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    res.end();
    return;
  }
  const form = await readForm(req, config.maxBodyBytes);
  if (!form) {
    oauthError(res, 400, "invalid_request", "Request body is missing or too large.");
    return;
  }
  const clientId = form.get("client_id");
  if (!config.clientId || clientId !== config.clientId) {
    oauthError(res, 401, "invalid_client", "Unknown client_id.");
    return;
  }
  const grantType = form.get("grant_type");
  const resource = form.get("resource");
  if (grantType === "authorization_code") {
    const code = form.get("code");
    const redirectUri = form.get("redirect_uri");
    const verifier = form.get("code_verifier");
    if (!code || !redirectUri || !verifier) {
      oauthError(res, 400, "invalid_request", "code, redirect_uri and code_verifier are required.");
      return;
    }
    if (!validPkceValue(verifier)) {
      oauthError(res, 400, "invalid_grant", "code_verifier is malformed.");
      return;
    }
    if (resource !== null && resource !== config.resource) {
      oauthError(res, 400, "invalid_target", "resource does not match this server.");
      return;
    }
    const row = db.claimAuthCode(hashSecret(code), Date.now());
    if (!row || row.client_id !== clientId || row.redirect_uri !== redirectUri) {
      oauthError(res, 400, "invalid_grant", "Authorization code is invalid, expired or already used.");
      return;
    }
    if (!verifyPkce(verifier, row.code_challenge)) {
      oauthError(res, 400, "invalid_grant", "PKCE verification failed.");
      return;
    }
    json(res, 200, issueTokens(config, db, clientId, row.scope, row.resource));
    return;
  }
  if (grantType === "refresh_token") {
    const token = form.get("refresh_token");
    if (!token) {
      oauthError(res, 400, "invalid_request", "refresh_token is required.");
      return;
    }
    const row = db.findOAuthToken(hashSecret(token));
    if (!row || row.kind !== "refresh" || row.revoked || row.expires_at <= Date.now() || row.client_id !== clientId) {
      oauthError(res, 400, "invalid_grant", "Refresh token is invalid, expired or revoked.");
      return;
    }
    db.revokeOAuthToken(row.token_hash); // rotation: the presented refresh token dies here
    json(res, 200, issueTokens(config, db, clientId, row.scope, row.resource));
    return;
  }
  oauthError(res, 400, "unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
}

async function handleRevoke(req: IncomingMessage, res: ServerResponse, config: OAuthConfig, db: KinKeepDb) {
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    res.end();
    return;
  }
  const form = await readForm(req, config.maxBodyBytes);
  if (!form) {
    oauthError(res, 400, "invalid_request", "Request body is missing or too large.");
    return;
  }
  const token = form.get("token");
  if (token) db.revokeOAuthToken(hashSecret(token));
  json(res, 200, {});
}

// Returns true when the request was an OAuth or discovery path and has been handled.
export async function handleOAuthRequest(req: IncomingMessage, res: ServerResponse, url: URL, config: OAuthConfig, db: KinKeepDb): Promise<boolean> {
  switch (url.pathname) {
    case "/.well-known/oauth-protected-resource":
    case "/.well-known/oauth-protected-resource/mcp":
      json(res, 200, protectedResourceMetadata(config));
      return true;
    case "/.well-known/oauth-authorization-server":
      json(res, 200, authorizationServerMetadata(config));
      return true;
    case "/oauth/authorize":
      await handleAuthorize(req, res, url, config, db);
      return true;
    case "/oauth/token":
      await handleToken(req, res, config, db);
      return true;
    case "/oauth/revoke":
      await handleRevoke(req, res, config, db);
      return true;
    default:
      return false;
  }
}
