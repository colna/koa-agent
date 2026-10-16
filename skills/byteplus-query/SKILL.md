---
name: byteplus-query
description: Use this skill to query BytePlus Analytics/DataFinder data with the bundled signed OpenAPI helper, including app lookup, metadata, dashboards, reports, cohorts, tags, usage, exports, user profiles, behavior flows, and PWA call summaries. Also use it when maintaining the older sitin-byteplus-mcp-server integration.
---

# BytePlus Query

## What This Skill Is For

Use this when the user asks to query or operate BytePlus Analytics/DataFinder. The skill is standalone for common live queries: use `scripts/byteplus-query.mjs`, which implements the AK/SK signed DataFinder OpenAPI client directly.

The old `sitin-byteplus-mcp-server` project is no longer required for normal querying. Keep it only as a compatibility fallback or when the user explicitly asks to maintain that project.

## Credentials

Never copy, reveal, or persist BytePlus AK/SK values. The helper reads credentials from:

- `BYTEPLUS_ACCESS_KEY`
- `BYTEPLUS_SECRET_KEY`
- optional `BYTEPLUS_BASE_URL`, defaulting to `https://analytics.byteplusapi.com`
- optional `BYTEPLUS_ENV_FILE`, pointing to a dotenv file

## First Moves

1. Resolve the app first. For local catalog lookup:

```bash
node skills/byteplus-query/scripts/byteplus-query.mjs apps pwa
```

2. For live BytePlus data, use the bundled helper directly:

```bash
node skills/byteplus-query/scripts/byteplus-query.mjs user-profile 653834 user_unique_id 7333418
node skills/byteplus-query/scripts/byteplus-query.mjs user-call-summary 653834 7333418
```

3. If credentials live in a specific dotenv file:

```bash
BYTEPLUS_ENV_FILE=/path/to/.env node skills/byteplus-query/scripts/byteplus-query.mjs user-call-summary 653834 7333418
```

4. Use `references/app-catalog.md` if you need to inspect the app table in context. PWA is currently `app_id=653834`.

## Common Commands

- App lookup: `node .../scripts/byteplus-query.mjs apps <keyword>`
- Event schema: `node .../scripts/byteplus-query.mjs list-events <app_id> [filter-json]`
- Event params: `node .../scripts/byteplus-query.mjs list-event-params <app_id> [filter-json]`
- User profile: `node .../scripts/byteplus-query.mjs user-profile <app_id> <query_type> <query_id>`
- User flow: `node .../scripts/byteplus-query.mjs user-flows <app_id> <query_type> <query_id> [orientation] [timestamp_ms] [count]`
- PWA call summary: `node .../scripts/byteplus-query.mjs user-call-summary <app_id> <query_id> [query_type=user_unique_id] [count=5000] [timestamp_ms=Date.now]`
- Generic signed request: `node .../scripts/byteplus-query.mjs request <METHOD> <PATH> [body-json] [query-json]`
- Full command list: `node .../scripts/byteplus-query.mjs help`

## Operational Rules

- Most tool calls require `app_id`. Ask the app name only if it cannot be inferred from the user request or catalog.
- For date ranges, use exact `YYYY-MM-DD` values. Raw event download only supports the recent 7-day window; custom export supports ranges from `2020-01-01` with max 365 days.
- For potentially destructive actions, summarize the target app and object, then get user confirmation before acting. The bundled helper intentionally omits delete/update cohort shortcuts; use the generic `request` command only after confirmation.
- Return concise summaries of API results. If the response is large, extract the key IDs, names, dates, counts, statuses, and error messages instead of dumping all JSON.

## Tool Selection

Read `references/tool-catalog.md` when you need endpoint mapping. Read `references/openapi-summary.md` when debugging signing or adding an endpoint to the helper.

Common flows:

- Find app: `apps`.
- List dashboards: `dashboards`, then `dashboard-reports`, then `report-data`.
- Discover event schema: `list-events`, `list-event-params`, `list-user-profiles`.
- Run DSL analysis: `analysis`; if the API returns a result id, use `analysis-result`.
- Inspect cohorts: `cohorts`, `cohort-info`, `cohort-sample`.
- Inspect tags: `tags`, `tag-info`, `tag-result`.
- Usage: `usage-daily` or `usage-monthly`.
- User lookup: `user-profile`, then `user-flows`.
- PWA call counts: `user-call-summary` and count unique calls by `room_id` from `pwa_call_end`; raw event counts are useful diagnostics but can double count one call.

## Maintaining Or Extending

When extending this standalone skill:

1. Keep the three-layer pattern:
   - `scripts/byteplus-query.mjs`: signed request wrapper and CLI commands.
   - `references/tool-catalog.md`: command/tool endpoint map.
   - `references/app-catalog.md`: non-secret app catalog.
2. Build endpoint paths without duplicating `/datafinder`; the script adds `SERVICE_PREFIX`.
3. Add deterministic summary commands for repeated analysis tasks instead of retyping long one-off scripts.
4. Validate syntax with `node --check scripts/byteplus-query.mjs`.

When maintaining the old `sitin-byteplus-mcp-server`, read `references/openapi-summary.md` and preserve the original client/tool split.

## Troubleshooting

- Repeated HTTP 400 from BytePlus: inspect signature inputs, app id, date format, endpoint path, and request body. The client retries HTTP 400 up to three times.
- `ECONNRESET`, `ETIMEDOUT`, or `ECONNREFUSED`: the client retries transient network failures; verify base URL and network access if all retries fail.
- Empty app results: try app display name, app name, or numeric app id; matching is case-insensitive for names.
- `Unknown session` on `/messages`: only relevant for the old MCP server fallback; reconnect to `/sse`.
