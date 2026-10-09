import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isValidBearerAuthorization, validConfiguredToken } from "./security.js";
import { oauthConfig, resolveOAuthAccess, handleOAuthRequest } from "./oauth.js";
import { KinKeepDb, todayIso, parseFlexibleDate, toIsoTimestamp, speakableTime, speakableDate, dayPreposition } from "./db.js";

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.KINKEEP_DB ?? "kinkeep.db";
const READ_TOKEN = process.env.KINKEEP_READ_TOKEN;
const WRITE_TOKEN = process.env.KINKEEP_WRITE_TOKEN;
const PUBLIC_ORIGIN = process.env.KINKEEP_PUBLIC_ORIGIN;
const MAX_BODY_BYTES = Number(process.env.KINKEEP_MAX_BODY_BYTES ?? 65_536);
const MAX_SESSIONS = Number(process.env.KINKEEP_MAX_SESSIONS ?? 100);
const SESSION_TTL_MS = Number(process.env.KINKEEP_SESSION_TTL_MS ?? 30 * 60 * 1000);
const ORIGINS = process.env.KINKEEP_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("PORT must be an integer from 1 to 65535");
if (!Number.isSafeInteger(MAX_BODY_BYTES) || MAX_BODY_BYTES < 1024) throw new Error("KINKEEP_MAX_BODY_BYTES must be an integer of at least 1024");
if (!Number.isSafeInteger(MAX_SESSIONS) || MAX_SESSIONS < 1) throw new Error("KINKEEP_MAX_SESSIONS must be a positive integer");
if (!Number.isSafeInteger(SESSION_TTL_MS) || SESSION_TTL_MS < 60_000) throw new Error("KINKEEP_SESSION_TTL_MS must be an integer of at least 60000");
if (!validConfiguredToken(READ_TOKEN) || !validConfiguredToken(WRITE_TOKEN)) throw new Error("KINKEEP_READ_TOKEN and KINKEEP_WRITE_TOKEN must be random base64url tokens of at least 43 characters");
if (READ_TOKEN === WRITE_TOKEN) throw new Error("KINKEEP_READ_TOKEN and KINKEEP_WRITE_TOKEN must be different");
if (PUBLIC_ORIGIN) {
  const parsed = new URL(PUBLIC_ORIGIN);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== PUBLIC_ORIGIN || parsed.username || parsed.password) throw new Error("KINKEEP_PUBLIC_ORIGIN must be a canonical http(s) origin without a path");
}

const db = new KinKeepDb(DB_PATH);
db.migrate();
const seeded = db.seedIfEmpty();
if (seeded) console.log(`[kinkeep] Seeded fresh database at ${DB_PATH}`);

// OAuth issuer and protected resource identity. A real deployment sets
// KINKEEP_PUBLIC_ORIGIN to the canonical https origin behind its proxy.
const KINKEEP_ORIGIN = PUBLIC_ORIGIN ?? `http://localhost:${PORT}`;
const oauth = oauthConfig(KINKEEP_ORIGIN, READ_TOKEN!, WRITE_TOKEN!, MAX_BODY_BYTES);
if (!PUBLIC_ORIGIN) console.warn(`[kinkeep] KINKEEP_PUBLIC_ORIGIN is unset; OAuth metadata advertises ${KINKEEP_ORIGIN}. Set it to the canonical origin before linking a real client.`);
if (!oauth.clientId) console.warn("[kinkeep] KINKEEP_OAUTH_CLIENT_ID is unset; /oauth/authorize will reject every client until one is registered.");
else if (oauth.redirectUris.length === 0) console.warn("[kinkeep] KINKEEP_OAUTH_CLIENT_ID is set but KINKEEP_OAUTH_REDIRECT_URIS is empty; every authorization request will be rejected.");
else console.log(`[kinkeep] OAuth authorization server at ${oauth.origin}, resource ${oauth.resource}`);

export function buildServer(): McpServer {
  const server = new McpServer({ name: "kinkeep", version: "0.1.0" });
  server.tool("get_day_briefing", "Read out the older adult's plan for a single day: appointments, which doses are still outstanding, and open reminders. This is the default tool for 'what's happening today'.", { day: z.string().max(100).optional().describe("'today', 'tomorrow', 'next Monday', or YYYY-MM-DD. Defaults to today.") }, async ({ day }) => {
    const dayIso = day ? parseFlexibleDate(day) : todayIso();
    if (!dayIso) return { content: [{ type: "text", text: `I couldn't understand "${day}" as a date. Try "today", "tomorrow", "next Monday", or a date like 2026-10-23.` }], isError: true };
    const appts = db.appointmentsOn(dayIso), meds = db.medications(), logs = db.medLogsOn(dayIso);
    const takenIds = new Set(logs.map((l) => l.medication_id));
    const outstanding = meds.filter((m) => !takenIds.has(m.id));
    const reminders = db.remindersOpen().filter((r) => r.due_at.slice(0, 10) <= dayIso);
    const lines = [`Here's the plan for ${speakableDate(dayIso)}.`];
    lines.push(appts.length ? appts.map((a) => `${a.title} at ${speakableTime(a.starts_at)}${a.with_whom ? ` with ${a.with_whom}` : ""}`).join("; ") : "Nothing booked in the diary.");
    lines.push(outstanding.length ? outstanding.map((m) => `${m.name} ${m.dose}${m.with_food ? " with food" : ""} due at ${m.times.split(",").map((t) => speakableTime(`${dayIso}T${t.trim()}:00`)).join(" and ")}`).join("; ") : "All today's doses are already logged.");
    lines.push(reminders.length ? reminders.map((r) => r.text).join("; ") : "No open reminders.");
    return { content: [{ type: "text", text: lines.join("\n") }] };
  });
  server.tool("list_appointments", "List upcoming appointments.", { limit: z.number().int().min(1).max(20).optional() }, async ({ limit }) => { const rows = db.upcomingAppointments(limit ?? 10); return { content: [{ type: "text", text: rows.length ? rows.map((a) => `${a.title} — ${speakableDate(a.starts_at)} at ${speakableTime(a.starts_at)}, ${a.duration_min} minutes${a.with_whom ? `, with ${a.with_whom}` : ""}`).join("\n") : "No upcoming appointments." }] }; });
  server.tool("add_appointment", "Add a new appointment to the diary.", { title: z.string().min(2).max(200), date: z.string().max(100), time: z.string().max(5), duration_min: z.number().int().min(5).max(480).optional(), with_whom: z.string().max(120).optional(), notes: z.string().max(2000).optional() }, async (args) => { const startsAt = toIsoTimestamp(args.date, args.time); if (!startsAt) return { content: [{ type: "text", text: `I couldn't build a time from date "${args.date}" and time "${args.time}".` }], isError: true }; const row = db.addAppointment(args.title, startsAt, args.duration_min ?? 60, args.with_whom ?? null, args.notes ?? null); return { content: [{ type: "text", text: `Added: ${row.title}, ${dayPreposition(row.starts_at)}${speakableDate(row.starts_at)} at ${speakableTime(row.starts_at)}.` }] }; });
  server.tool("complete_appointment", "Mark an appointment as done by its number.", { appointment_id: z.number().int().positive() }, async ({ appointment_id }) => { const ok = db.completeAppointment(appointment_id); return { content: [{ type: "text", text: ok ? `Marked appointment ${appointment_id} as done.` : `No appointment with id ${appointment_id}.` }], isError: !ok }; });
  server.tool("list_medications", "List the medication schedule.", {}, async () => { const rows = db.medications(); return { content: [{ type: "text", text: rows.map((m) => `${m.name} ${m.dose} at ${m.times}${m.with_food ? " — with food" : ""}${m.notes ? ` (${m.notes})` : ""}`).join("\n") }] }; });
  server.tool("log_medication", "Record a dose only after the person confirms they took it.", { medication_name: z.string().min(1).max(120) }, async ({ medication_name }) => { const rows = db.medications(), hit = rows.find((m) => m.name.toLowerCase() === medication_name.toLowerCase()); if (!hit) return { content: [{ type: "text", text: `No medication called "${medication_name}". The schedule has: ${rows.map((m) => m.name).join(", ")}.` }], isError: true }; const log = db.logMedication(hit.id, new Date().toISOString()); return { content: [{ type: "text", text: `Logged: ${hit.name} ${hit.dose} taken at ${speakableTime(log.taken_at)}.` }] }; });
  server.tool("list_reminders", "List reminders that are not yet done.", {}, async () => { const rows = db.remindersOpen(); return { content: [{ type: "text", text: rows.length ? rows.map((r) => `${r.id}. ${r.text} — ${speakableDate(r.due_at)} ${speakableTime(r.due_at)}`).join("\n") : "No open reminders." }] }; });
  server.tool("add_reminder", "Set a new reminder.", { text: z.string().min(3).max(1000), date: z.string().max(100), time: z.string().max(5) }, async (args) => { const dueAt = toIsoTimestamp(args.date, args.time); if (!dueAt) return { content: [{ type: "text", text: `I couldn't build a time from date "${args.date}" and time "${args.time}".` }], isError: true }; const row = db.addReminder(args.text, dueAt); return { content: [{ type: "text", text: `Reminder set: ${row.text}, ${speakableDate(row.due_at)} at ${speakableTime(row.due_at)}.` }] }; });
  server.tool("complete_reminder", "Mark a reminder as done by its number.", { reminder_id: z.number().int().positive() }, async ({ reminder_id }) => { const ok = db.completeReminder(reminder_id); return { content: [{ type: "text", text: ok ? `Marked reminder ${reminder_id} as done.` : `No reminder with id ${reminder_id}.` }], isError: !ok }; });
  server.tool("who_visited", "Read recent journal entries, newest first.", { limit: z.number().int().min(1).max(30).optional() }, async ({ limit }) => { const rows = db.journalRecent(limit ?? 8); return { content: [{ type: "text", text: rows.length ? rows.map((e) => `${speakableDate(e.at)} ${speakableTime(e.at)} — ${e.kind}: ${e.text}${e.by ? ` (${e.by})` : ""}`).join("\n") : "The journal is empty." }] }; });
  server.tool("log_journal", "Add a journal entry.", { kind: z.enum(["visit", "call", "note"]), text: z.string().min(3).max(2000), by: z.string().max(120).optional() }, async (args) => { const row = db.addJournal(args.kind, args.text, new Date().toISOString(), args.by ?? null); return { content: [{ type: "text", text: `Logged ${row.kind}: ${row.text}` }] }; });
  server.tool("who_can_help", "List the care circle and phone numbers.", {}, async () => { const rows = db.listCircle(); return { content: [{ type: "text", text: rows.map((m) => `${m.name} — ${m.role}${m.phone ? `, phone ${m.phone}` : ""}`).join("\n") }] }; });
  server.resource("briefing", "kinkeep://briefing/today", { description: "Today's day briefing as plain text" }, async () => { const dayIso = todayIso(), appts = db.appointmentsOn(dayIso); const body = appts.length ? appts.map((a) => `${a.title} at ${speakableTime(a.starts_at)}`).join("; ") : "Nothing booked."; return { contents: [{ uri: "kinkeep://briefing/today", text: `Today: ${body}` }] }; });
  return server;
}

interface SessionEntry { transport: StreamableHTTPServerTransport; lastSeen: number; accessMode: "read" | "write"; }
const transports = new Map<string, SessionEntry>();
function pruneSessions(): void { const cutoff = Date.now() - SESSION_TTL_MS; for (const [id, entry] of transports) if (entry.lastSeen < cutoff) { transports.delete(id); void entry.transport.close(); } db.pruneOAuth(Date.now()); }
const sessionTimer = setInterval(pruneSessions, Math.min(60_000, SESSION_TTL_MS));
sessionTimer.unref();

const httpServer = createServer(async (req, res) => {
  const base = PUBLIC_ORIGIN ?? `http://localhost:${PORT}`;
  let url: URL;
  try { url = new URL(req.url ?? "/", base); } catch { res.writeHead(400).end(); return; }
  const requestHost = req.headers.host ?? "";
  const testHost = process.env.KINKEEP_TEST_HOST;
  const allowedHosts = PUBLIC_ORIGIN ? new Set([new URL(PUBLIC_ORIGIN).host, ...(testHost ? [testHost] : [])]) : new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
  if (!allowedHosts.has(requestHost)) { res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "invalid Host header" })); return; }
  if (await handleOAuthRequest(req, res, url, oauth, db)) return;
  if (url.pathname !== "/mcp") { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }
  const requestOrigin = req.headers.origin;
  if (requestOrigin && ORIGINS && !ORIGINS.includes(requestOrigin)) { res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "invalid Origin header" })); return; }
  if (req.method !== "POST") { res.writeHead(405, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "method not allowed" })); return; }
const authorization = req.headers.authorization;
  const accessMode = isValidBearerAuthorization(authorization, READ_TOKEN!) ? "read" : isValidBearerAuthorization(authorization, WRITE_TOKEN!) ? "write" : resolveOAuthAccess(db, authorization);
  if (!accessMode) { res.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
  const length = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) { res.writeHead(413, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "request body too large" })); req.destroy(); return; }
  let raw = "";
  for await (const chunk of req) { raw += chunk.toString(); if (Buffer.byteLength(raw) > MAX_BODY_BYTES) { res.writeHead(413, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "request body too large" })); req.destroy(); return; } }
  let message: unknown;
  try { message = JSON.parse(raw); } catch { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null })); return; }
  if (accessMode === "read" && typeof message === "object" && message !== null) {
    const request = message as { method?: unknown; params?: { name?: unknown } };
    const writeTools = new Set(["add_appointment", "complete_appointment", "log_medication", "add_reminder", "complete_reminder", "log_journal"]);
    if (request.method === "tools/call" && typeof request.params?.name === "string" && writeTools.has(request.params.name)) {
      res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "read-only credential cannot call write tools" }));
      return;
    }
  }

  const header = req.headers["mcp-session-id"], sessionId = Array.isArray(header) ? header[0] : header;
  try {
    let entry = sessionId ? transports.get(sessionId) : undefined;
    if (!isInitializeRequest(message) && !entry) { res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "unknown MCP session" })); return; }
    if (isInitializeRequest(message)) {
      if (entry) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: "Invalid request: already initialised" }, id: (message as { id?: unknown }).id ?? null })); return; }
      pruneSessions();
      if (transports.size >= MAX_SESSIONS) { res.writeHead(503, { "content-type": "application/json", "retry-after": "60" }); res.end(JSON.stringify({ error: "session capacity reached" })); return; }
      const id = randomUUID(), transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => id, enableJsonResponse: true, maxRequestBodySize: MAX_BODY_BYTES });
      await buildServer().connect(transport);
      entry = { transport, lastSeen: Date.now(), accessMode };
      transports.set(id, entry);
      transport.onclose = () => transports.delete(id);
    }
    if (!entry) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: no valid session. Send an initialize request first." }, id: null })); return; }
    if (entry.accessMode === "read" && accessMode === "write") { res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "session token does not have write access" })); return; }
    entry.lastSeen = Date.now();
    await entry.transport.handleRequest(req, res, message);
  } catch (err) { console.error("[kinkeep] request failed:", err); if (!res.headersSent) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null })); } }
});
httpServer.headersTimeout = 10_000;
httpServer.requestTimeout = 30_000;
httpServer.listen(PORT, () => { console.log(`[kinkeep] MCP server listening on port ${PORT}; bearer authentication required`); console.log("[kinkeep] Protocol 2025-11-25, Streamable HTTP transport"); });
