# Deploying KinKeep

Two different things get called "deployed" here, and they do not go to the same place:

| Piece | Where it runs | How |
|---|---|---|
| Landing page in `site/` | Cloudflare Workers, static assets | `wrangler deploy` |
| MCP server in `src/` | Anywhere you self-host Node | `npm run build`, then run `dist/server.js` |

The MCP server holds household data and is deliberately self-hosted. Do not put it on a
serverless host without a review. Everything below is about the landing-page worker.

## Prerequisites

- Node 22+, with access to the npm registry.
- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment. Inject them from a secret
  manager; never commit either, and never paste a token into an issue or a chat.

### Token permissions

Use a **custom** token. A dashboard template will not cover this, because the calls we need sit
under three separate permission groups:

| Scope | Needed for |
|---|---|
| Account · Workers Scripts · Edit | `wrangler deploy` |
| Zone · Workers Routes · Edit | binding a hostname to the worker (see below) |
| Zone · DNS · Read | resolving the zone, and reading records while debugging |
| Account · Workers Custom Domains · Edit | only if you bind with a custom domain instead of a route |

`wrangler.jsonc` declares an assets-only worker named `kinkeep` serving `./site`.

## Deploy

```sh
export CLOUDFLARE_ACCOUNT_ID=...
# CLOUDFLARE_API_TOKEN is already exported
npx wrangler@4.149.0 deploy
```

Validate the config without touching Cloudflare first:

```sh
npx wrangler@4.149.0 deploy --dry-run --outdir /tmp/kinkeep-dry
```

The real deploy prints the `*.workers.dev` URL and a version id. Assets are cached, so verify with a
cache-busting query string rather than a plain reload.

## Custom hostname

Two ways to put a real domain in front of the worker. They are not interchangeable.

**Custom domain** — Cloudflare owns the DNS record and the certificate. Declare it in
`wrangler.jsonc` as `routes: [{ pattern: "<host>", custom_domain: true }]`, or POST to
`/accounts/{account_id}/workers/domains`. Requires Workers Custom Domains: Edit. Without that scope
the API answers:

```json
{"success":false,"errors":[{"code":10405,"message":"Method not allowed for this authentication scheme"}]}
```

**Workers route** — works with the smaller scope set. The hostname must already resolve through
Cloudflare, which a proxied wildcard such as `*.example.com` provides. Create the route:

```sh
curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/workers/routes" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{"pattern":"<host>/*","script":"kinkeep"}'
```

Trade-off: a route rides on the DNS record that already exists, and a loose pattern lets other
proxied hostnames reach the worker. Use the tightest pattern that works.

## Verify

```sh
curl -s -o /dev/null -w '%{http_code}\n' "https://<host>/?cb=$(date +%s)"
curl -s "https://<host>/?cb=$(date +%s)" | grep -o '<title>[^<]*</title>'
```

`200` and `<title>KinKeep — the family care notebook</title>` is the whole check.

## Undo

```sh
curl -X DELETE "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/workers/routes/<route_id>" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```
