# KinKeep

A self-hosted **MCP server for elder-care coordination**, built for the Alexa+ track of the
[Amazon Developer Hackathon](https://amazonappdev2026.devpost.com/).

KinKeep gives an older adult one place to ask, by voice, what their day looks like — and lets a
family carer add to it without installing another app. Alexa+ reads the schedule, logs that a dose
has been taken, sets a reminder, or answers *"has anyone been in today?"*

> **Why this.** Most calendar and medication apps are built for someone who can see a small screen,
> navigate menus, and type with their thumbs. A large share of the people who actually need a daily
> schedule in front of them cannot do any of those things reliably. Voice is the access technology
> that already sits in their living room. MCP is the open standard Alexa+ uses to reach external
> services, so a self-hosted MCP server is the shortest path from an unmet need to a thing that
> actually answers them.

## Status

Working. Implements the **MCP 2025-11-25 Streamable HTTP transport**, verified end-to-end with a
real client over HTTP: session negotiation, 12 tools, 1 resource, structured error responses, and
concurrent sessions.

## Run it

Needs Node 22+.

`npm run dev` expects `KINKEEP_READ_TOKEN` and `KINKEEP_WRITE_TOKEN` to already be set; the command below generates independent values for a local run. For persistent use, inject both from a secret manager instead of regenerating on each restart.

```sh
npm install
KINKEEP_READ_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')" \
KINKEEP_WRITE_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')" npm run dev
```

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `KINKEEP_READ_TOKEN` | required | Random base64url token (at least 43 characters) for read-only access. |
| `KINKEEP_WRITE_TOKEN` | required | A different random base64url token (at least 43 characters) for read and write access. |
| `KINKEEP_DB` | `kinkeep.db` | SQLite path. |
| `KINKEEP_ORIGINS` | unset | Optional comma-separated Origin allowlist; defense in depth only, not authentication. |
| `KINKEEP_PUBLIC_ORIGIN` | unset | Canonical public origin for metadata URLs, e.g. `https://care.example`. |
| `KINKEEP_MAX_BODY_BYTES` | `65536` | Maximum MCP request-body size. |
| `KINKEEP_MAX_SESSIONS` | `100` | Maximum concurrent sessions. |
| `KINKEEP_SESSION_TTL_MS` | `1800000` | Inactivity expiry in milliseconds; minimum 60000. |

- `KINKEEP_READ_TOKEN` is required for read access; a separate `KINKEEP_WRITE_TOKEN` is required for writes. Their values must be distinct, random base64url strings of at least 43 characters. Generate each independently with `node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'`; inject them through a secret manager or process environment, never a checked-in `.env` file.

This repository is a prototype. The OAuth 2.1 authorization-code flow required for Alexa+ account linking is not implemented, so Alexa+ cannot connect to KinKeep through account linking yet. The static read/write bearer tokens are useful for self-hosted MCP clients but do not implement Alexa OAuth. Discovery endpoints intentionally return 404. Before Alexa+ integration, implement and review client registration, authorization, PKCE, token/refresh handling, revocation, and per-user scope enforcement.

The database is seeded on first run with a realistic **synthetic** household. A fresh database has appointments anchored relative to its first startup; use that fixture for demos, and never place real household data in the repository or sample database.

## Endpoint

Everything is on a single path, per spec:

```
POST /mcp          JSON-RPC 2.0 over Streamable HTTP
GET  /mcp          rejected with 405 (no SSE stream is offered)
```

The discovery documents and `/oauth/*` flow are not implemented. Do not rely on KinKeep for Alexa+ account linking until a complete authorization flow is implemented and reviewed.

## Security notes

- A read token is denied calls to write tools; the distinct write token can call all tools.
- TLS is required when the service is accessed over a network. Terminate HTTPS at a trusted reverse proxy and set `KINKEEP_PUBLIC_ORIGIN` to its public origin.
- Bodies default to a 64 KiB cap, sessions to 100 concurrent sessions, with a 30-minute inactivity expiry. Configure limits for the deployment.
- Origin allowlisting is optional browser/DNS-rebinding defense only. It is not authentication.
- OAuth discovery is intentionally disabled until a real OAuth implementation exists.
The HTTP integration suite covers credentials, read/write roles, body/session limits, Host/Origin restrictions, and disabled OAuth discovery. It is not an independent penetration test; do not use real care data without deployment-specific review, encrypted backups, and household access controls.



| Tool | What it does |
|---|---|
| `get_day_briefing` | The default tool. Appointments, outstanding doses, and open reminders for one day, as natural spoken text. |
| `list_appointments` | Upcoming diary entries. |
| `add_appointment` | Add one. Accepts `today`, `tomorrow`, `next Monday`, or `YYYY-MM-DD`. |
| `complete_appointment` | Mark one done by id. |
| `list_medications` | The current schedule. |
| `log_medication` | Record that a named dose was taken. Refuses names not on the schedule. |
| `list_reminders` | Open reminders, oldest first. |
| `add_reminder` | Set one with a date and time. |
| `complete_reminder` | Mark one done by id. |
| `who_visited` | Recent journal: visits, calls, notes such as a blood-pressure reading. |
| `log_journal` | Add a journal entry. |
| `who_can_help` | The care circle and their phone numbers. |

One resource is exposed: `kinkeep://briefing/today`.

All output is written to be read aloud rather than read. Times render as "4 pm", not "16:00"; dates
render as "tomorrow", not "2026-10-05".

## Try it

First, export `KINKEEP_WRITE_TOKEN` in the shell. Include this bearer header and the returned session ID on each request:

```sh
curl -X POST http://localhost:3000/mcp \
  -H 'authorization: Bearer <write-token>' \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{"protocolVersion":"2025-11-25","capabilities":{},
                 "clientInfo":{"name":"example","version":"1.0.0"}}}'
```

Then repeat with the returned `mcp-session-id` header:

```sh
curl -X POST http://localhost:3000/mcp \
  -H 'authorization: Bearer <write-token>' \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: <session id>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"get_day_briefing","arguments":{}}}'
```

The project root also has `dev.sh` (stop-and-restart) for development.

## Layout

```
src/server.ts     HTTP layer, bearer authorization, transport, bounded sessions
src/security.ts   bearer-token validation
src/db.ts         SQLite access, seeding, date parsing, spoken-time formatting
src/schema.sql    Table definitions
```

## License

Apache 2.0. See [LICENSE](./LICENSE).
