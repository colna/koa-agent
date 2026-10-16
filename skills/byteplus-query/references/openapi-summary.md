# BytePlus DataFinder OpenAPI Summary

Use this when extending or debugging the MCP server. The current project wraps DataFinder APIs behind a single signed JSON client.

## Base URLs

- BytePlus overseas non-cloud-native SaaS: `https://analytics.byteplusapi.com`
- Volcengine SaaS cloud-native or China non-cloud-native: `https://analytics.volcengineapi.com`
- Private deployment: use the deployment-specific product domain.

The project client prepends `SERVICE_PREFIX = "/datafinder"` to every endpoint path before signing and fetching.

## AK/SK Signing As Implemented

The `Authorization` header format is:

```text
ak-v1/{access_key}/{timestamp}/{expire_seconds}/{signature}
```

Algorithm in `src/byteplus/auth.ts`:

1. `timestamp = Math.floor(Date.now() / 1000)`.
2. `prefix = ak-v1/{accessKey}/{timestamp}/{expireSeconds}`.
3. `signKey = HMAC-SHA256(secretKey, prefix).digest("hex")`.
4. Canonical request is joined with newline characters:

```text
HTTPMethod:{UPPERCASE_METHOD}
CanonicalURI:{full_path}
CanonicalQueryString:{sorted_query_string}
CanonicalBody:{json_body_or_empty_string}
```

5. `signature = HMAC-SHA256(signKey, canonicalRequest).digest("hex")`.

The current query-string implementation sorts keys lexicographically and joins raw `key=value` pairs with `&`. Preserve this behavior unless you validate BytePlus signature compatibility after changing encoding.

## Request Wrapper Behavior

- Methods supported: `GET`, `POST`, `PATCH`, `DELETE`.
- JSON body is omitted for `GET`.
- `Content-Type` is always `application/json`.
- Response parsing tries JSON first; non-JSON responses become `{ raw, status }`.
- Retries: up to 3 attempts for HTTP 400 and transient network errors `ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`.

## Endpoint Families

- Raw event downloads:
  - `GET /openapi/v2/{app_id}/date/{begin_date}/{end_date}/downloads`
  - `POST /openapi/v1/{app_id}/date/{begin_date}/{end_date}/exports`
  - `GET /openapi/v1/{app_id}/exports`
- Dashboards and reports:
  - `GET /openapi/v1/{app_id}/dashboards/all`
  - `GET /openapi/v1/{app_id}/dashboards/{dashboard_id}`
  - `GET /openapi/v1/{app_id}/dashboards/{dashboard_id}/reports`
  - `GET` or `POST /openapi/v1/{app_id}/reports/{report_id}`
- Query analysis:
  - `POST /openapi/v1/analysis`
  - `GET /openapi/v1/analysis/{result_id}/result`
  - `POST /openapi/v1/{app_id}/downloads`
- Cohorts:
  - `GET /openapi/v1/{app_id}/cohorts`
  - `GET /openapi/v1/{app_id}/cohorts/{cohort_id}`
  - `GET /openapi/v1/{app_id}/cohorts/{cohort_id}/sample`
  - `GET /openapi/v1/{app_id}/cohorts/{cohort_id}/download`
  - `POST /openapi/v1/{app_id}/cohorts`
  - `GET /openapi/v1/{app_id}/cohorts/{cohort_id}/refresh`
  - `DELETE /openapi/v1/{app_id}/cohorts/{cohort_id}`
  - `PATCH /openapi/v1/{app_id}/cohorts/{cohort_id}`
- Metadata:
  - `POST /openapi/v1/metadata/apps`
  - `POST /openapi/v1/metadata/{app_id}/list/events`
  - `POST /openapi/v1/metadata/{app_id}/list/params`
  - `POST /openapi/v1/metadata/{app_id}/list/user_profiles`
- Tags:
  - `GET /openapi/v1/app/{app_id}/tag`
  - `GET /openapi/v1/app/{app_id}/tag/{tag_name}`
  - `GET /openapi/v1/app/{app_id}/tag/{tag_name}/result`
- Usage:
  - `POST /openapi/v1/usage_amount`
  - `POST /openapi/v1/usage_amount/daily`
- User behavior:
  - `POST /openapi/v1/{app_id}/behaviors/profiles`
  - `POST /openapi/v1/{app_id}/behaviors/flows`

## Adding A New Endpoint

1. Add a function in `src/byteplus/client.ts` using `request({ method, path, query?, body? })`.
2. Keep endpoint paths relative to `/datafinder`; do not include the service prefix.
3. Register a corresponding `server.registerTool()` in `src/byteplus/tools.ts`.
4. Use `zod` schemas that match required and optional inputs.
5. Build with `pnpm build`.
