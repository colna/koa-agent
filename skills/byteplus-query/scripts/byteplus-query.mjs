#!/usr/bin/env node
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVICE_PREFIX = "/datafinder";
const DEFAULT_BASE_URL = "https://analytics.byteplusapi.com";

const APP_LIST = [
  { name: "Doni_iOS", appId: "842643", appName: "doni" },
  { name: "Kira_Android", appId: "941399", appName: "kira_android" },
  { name: "Taro_iOS", appId: "941367", appName: "taro_ios" },
  { name: "Kira_iOS", appId: "925701", appName: "kira" },
  { name: "Romi_Android", appId: "923388", appName: "romi_android" },
  { name: "Yula_iOS", appId: "916035", appName: "yula" },
  { name: "Jovia_Android", appId: "906534", appName: "lovia_android" },
  { name: "Aura_iOS", appId: "885084", appName: "aura" },
  { name: "Elara_iOS", appId: "856233", appName: "elara" },
  { name: "Romi_iOS", appId: "844532", appName: "romi" },
  { name: "fantasy_aif", appId: "572257", appName: "aif" },
  { name: "Luma", appId: "817969", appName: "luma" },
  { name: "Doni_Android", appId: "812405", appName: "doni_android" },
  { name: "Dora_Android", appId: "799585", appName: "doraandroid" },
  { name: "Dora_iOS", appId: "789569", appName: "dora" },
  { name: "Lovia", appId: "774262", appName: "lovia" },
  { name: "pwa", appId: "653834", appName: "pwa_gracechat" },
  { name: "gracechat_iOS", appId: "623101", appName: "haven" },
  { name: "CaloriesAI", appId: "622189", appName: "calories" },
];

const CALL_SUMMARY_EVENTS = new Set([
  "pwa_call_end",
  "pwa_native_call_end",
  "pwa_call_begin_from_native",
  "pwa_call_connected",
  "pwa_video_call_started",
  "pwa_audio_call_started",
  "pwa_call_start",
  "pwa_video_call_accepted",
  "pwa_video_call_received",
  "pwa_voice_call_accepted",
  "pwa_voice_call_received",
  "pwa_video_call_hangup",
  "pwa_voice_call_hangup",
]);

function usage() {
  console.log(`BytePlus DataFinder helper

Usage:
  node scripts/byteplus-query.mjs apps [keyword]
  node scripts/byteplus-query.mjs request <METHOD> <PATH> [body-json] [query-json]
  node scripts/byteplus-query.mjs data-downloads <app_id> <begin_date> <end_date>
  node scripts/byteplus-query.mjs submit-export <app_id> <begin_date> <end_date>
  node scripts/byteplus-query.mjs exports <app_id>
  node scripts/byteplus-query.mjs dashboards <app_id>
  node scripts/byteplus-query.mjs dashboard-info <app_id> <dashboard_id>
  node scripts/byteplus-query.mjs dashboard-reports <app_id> <dashboard_id>
  node scripts/byteplus-query.mjs report-data <app_id> <report_id> [count] [filter_id]
  node scripts/byteplus-query.mjs analysis <dsl-json>
  node scripts/byteplus-query.mjs analysis-result <result_id>
  node scripts/byteplus-query.mjs batch-analysis <app_id> <result_id-or-> [dsl-json]
  node scripts/byteplus-query.mjs cohorts <app_id>
  node scripts/byteplus-query.mjs cohort-info <app_id> <cohort_id>
  node scripts/byteplus-query.mjs cohort-sample <app_id> <cohort_id> <count>
  node scripts/byteplus-query.mjs tags <app_id>
  node scripts/byteplus-query.mjs tag-info <app_id> <tag_name>
  node scripts/byteplus-query.mjs tag-result <app_id> <tag_name>
  node scripts/byteplus-query.mjs usage-daily <app_ids_csv> <start_time> <end_time>
  node scripts/byteplus-query.mjs usage-monthly <app_ids_csv> <start_time> <end_time>
  node scripts/byteplus-query.mjs list-events <app_id> [filter-json]
  node scripts/byteplus-query.mjs list-event-params <app_id> [filter-json]
  node scripts/byteplus-query.mjs list-user-profiles <app_id> [filter-json]
  node scripts/byteplus-query.mjs user-profile <app_id> <query_type> <query_id>
  node scripts/byteplus-query.mjs user-flows <app_id> <query_type> <query_id> [orientation=earlier] [timestamp_ms=Date.now] [count=100]
  node scripts/byteplus-query.mjs user-call-summary <app_id> <query_id> [query_type=user_unique_id] [count=5000] [timestamp_ms=Date.now]

Credentials:
  BYTEPLUS_ACCESS_KEY and BYTEPLUS_SECRET_KEY must be in the environment.
  BYTEPLUS_BASE_URL is optional and defaults to ${DEFAULT_BASE_URL}.
  BYTEPLUS_ENV_FILE can point at a dotenv file to load before reading env vars.
`);
}

function loadDotenv() {
  const candidates = [
    process.env.BYTEPLUS_ENV_FILE,
    resolve(process.cwd(), ".env"),
    resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env"),
  ].filter(Boolean);
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (!match || process.env[match[1]] !== undefined) continue;
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

function credentials() {
  loadDotenv();
  const accessKey = process.env.BYTEPLUS_ACCESS_KEY;
  const secretKey = process.env.BYTEPLUS_SECRET_KEY;
  const baseUrl = process.env.BYTEPLUS_BASE_URL || DEFAULT_BASE_URL;
  if (!accessKey || !secretKey) {
    throw new Error("Missing BYTEPLUS_ACCESS_KEY or BYTEPLUS_SECRET_KEY");
  }
  return { accessKey, secretKey, baseUrl };
}

function sign(creds, method, uri, queryString, body, expireSeconds = 1800) {
  const timestamp = Math.floor(Date.now() / 1000);
  const prefix = `ak-v1/${creds.accessKey}/${timestamp}/${expireSeconds}`;
  const signKey = createHmac("sha256", creds.secretKey).update(prefix).digest("hex");
  const canonicalRequest = [
    `HTTPMethod:${method.toUpperCase()}`,
    `CanonicalURI:${uri}`,
    `CanonicalQueryString:${queryString}`,
    `CanonicalBody:${body || ""}`,
  ].join("\n");
  const signature = createHmac("sha256", signKey).update(canonicalRequest).digest("hex");
  return `${prefix}/${signature}`;
}

function queryString(query) {
  if (!query || Object.keys(query).length === 0) return "";
  return Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

async function request(method, path, body, query) {
  const creds = credentials();
  const fullPath = SERVICE_PREFIX + path;
  const qs = queryString(query);
  const bodyText = body === undefined || method === "GET" ? "" : JSON.stringify(body);

  for (let attempt = 0; attempt < 3; attempt++) {
    const authorization = sign(creds, method, fullPath, qs, bodyText);
    const url = `${creds.baseUrl}${fullPath}${qs ? `?${qs}` : ""}`;
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: method === "GET" || !bodyText ? undefined : bodyText,
      });
      const text = await res.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text, status: res.status };
      }
      if (res.status === 400 && attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      return parsed;
    } catch (err) {
      if (["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"].includes(err?.cause?.code ?? err?.code) && attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonArg(value, fallback = {}) {
  if (value === undefined || value === "-") return fallback;
  return JSON.parse(value);
}

function appMatches(keyword) {
  if (!keyword) return APP_LIST;
  const needle = keyword.toLowerCase();
  return APP_LIST.filter((app) =>
    [app.name, app.appId, app.appName].some((value) => value.toLowerCase().includes(needle)),
  );
}

function asNumberArray(csv) {
  return csv.split(",").map((value) => Number(value.trim())).filter(Number.isFinite);
}

function shanghaiTime(ms) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

function msOf(event) {
  if (typeof event.local_time_ms === "number") return event.local_time_ms;
  if (typeof event.time === "number") return event.time * 1000;
  if (typeof event.event_time === "number") return event.event_time * 1000;
  return 0;
}

function summarizeCalls(response) {
  const flow = response?.data?.flow ?? [];
  const counts = {};
  const callEvents = [];
  for (const event of flow) {
    const name = event.event_name ?? event.event;
    if (!CALL_SUMMARY_EVENTS.has(name)) continue;
    const count = Number(event.repetition_cnt ?? 1);
    counts[name] = (counts[name] || 0) + count;
    callEvents.push(event);
  }

  const ends = flow
    .filter((event) => event.event_name === "pwa_call_end")
    .map((event) => {
      const params = event.params ?? {};
      return {
        time_ms: msOf(event),
        shanghai_time: shanghaiTime(msOf(event)),
        room_id: String(params.room_id ?? ""),
        is_success: String(params.is_success ?? ""),
        duration_seconds: Number(params.call_duration ?? 0),
        media_type: params.media_type ?? "",
        call_start_type: params.call_start_type ?? "",
        caller_id: String(params.caller_id ?? ""),
        callee_id: String(params.callee_id ?? ""),
        fail_reason: params.fail_reason ?? "",
      };
    })
    .sort((a, b) => b.time_ms - a.time_ms);

  const unique = new Map();
  for (const end of ends) {
    const key = end.room_id || `${end.time_ms}-${end.caller_id}-${end.callee_id}`;
    const existing = unique.get(key);
    if (!existing || end.duration_seconds > existing.duration_seconds) unique.set(key, end);
  }

  const uniqueEnds = [...unique.values()].sort((a, b) => b.time_ms - a.time_ms);
  const byDay = {};
  let success = 0;
  let failed = 0;
  let successDurationSeconds = 0;
  for (const end of uniqueEnds) {
    const day = end.shanghai_time.slice(0, 10);
    byDay[day] ??= { total: 0, success: 0, failed: 0, success_duration_seconds: 0 };
    byDay[day].total += 1;
    if (end.is_success === "true") {
      success += 1;
      successDurationSeconds += end.duration_seconds;
      byDay[day].success += 1;
      byDay[day].success_duration_seconds += end.duration_seconds;
    } else {
      failed += 1;
      byDay[day].failed += 1;
    }
  }

  const times = flow.map(msOf).filter(Boolean);
  return {
    code: response?.code,
    message: response?.message,
    flow_count: flow.length,
    window_shanghai: times.length
      ? { from: shanghaiTime(Math.min(...times)), to: shanghaiTime(Math.max(...times)) }
      : null,
    raw_call_event_counts: counts,
    pwa_call_end_raw_count: ends.length,
    call_count_unique_by_room: uniqueEnds.length,
    success_call_count: success,
    failed_call_count: failed,
    success_duration_seconds: Number(successDurationSeconds.toFixed(2)),
    by_day: byDay,
    latest_call_ends: uniqueEnds.slice(0, 50),
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }

  let out;
  switch (command) {
    case "apps":
      out = appMatches(args[0]);
      break;
    case "request":
      out = await request(args[0], args[1], jsonArg(args[2], undefined), jsonArg(args[3], undefined));
      break;
    case "data-downloads":
      out = await request("GET", `/openapi/v2/${args[0]}/date/${args[1]}/${args[2]}/downloads`);
      break;
    case "submit-export":
      out = await request("POST", `/openapi/v1/${args[0]}/date/${args[1]}/${args[2]}/exports`);
      break;
    case "exports":
      out = await request("GET", `/openapi/v1/${args[0]}/exports`);
      break;
    case "dashboards":
      out = await request("GET", `/openapi/v1/${args[0]}/dashboards/all`);
      break;
    case "dashboard-info":
      out = await request("GET", `/openapi/v1/${args[0]}/dashboards/${args[1]}`);
      break;
    case "dashboard-reports":
      out = await request("GET", `/openapi/v1/${args[0]}/dashboards/${args[1]}/reports`);
      break;
    case "report-data": {
      const query = {};
      if (args[2] !== undefined) query.count = args[2];
      if (args[3] !== undefined) query.filter_id = args[3];
      out = await request("GET", `/openapi/v1/${args[0]}/reports/${args[1]}`, undefined, query);
      break;
    }
    case "analysis":
      out = await request("POST", "/openapi/v1/analysis", jsonArg(args[0]));
      break;
    case "analysis-result":
      out = await request("GET", `/openapi/v1/analysis/${args[0]}/result`);
      break;
    case "batch-analysis":
      out = await request("POST", `/openapi/v1/${args[0]}/downloads`, args[1] && args[1] !== "-" ? { result_id: args[1] } : { dsl: jsonArg(args[2]) });
      break;
    case "cohorts":
      out = await request("GET", `/openapi/v1/${args[0]}/cohorts`);
      break;
    case "cohort-info":
      out = await request("GET", `/openapi/v1/${args[0]}/cohorts/${args[1]}`);
      break;
    case "cohort-sample":
      out = await request("GET", `/openapi/v1/${args[0]}/cohorts/${args[1]}/sample`, undefined, { count: args[2] });
      break;
    case "tags":
      out = await request("GET", `/openapi/v1/app/${args[0]}/tag`);
      break;
    case "tag-info":
      out = await request("GET", `/openapi/v1/app/${args[0]}/tag/${args[1]}`);
      break;
    case "tag-result":
      out = await request("GET", `/openapi/v1/app/${args[0]}/tag/${args[1]}/result`);
      break;
    case "usage-daily":
      out = await request("POST", "/openapi/v1/usage_amount/daily", { app_ids: asNumberArray(args[0]), start_time: args[1], end_time: args[2] });
      break;
    case "usage-monthly":
      out = await request("POST", "/openapi/v1/usage_amount", { app_ids: asNumberArray(args[0]), start_time: args[1], end_time: args[2] });
      break;
    case "list-events":
      out = await request("POST", `/openapi/v1/metadata/${args[0]}/list/events`, args[1] ? { filter: jsonArg(args[1]) } : {});
      break;
    case "list-event-params":
      out = await request("POST", `/openapi/v1/metadata/${args[0]}/list/params`, args[1] ? { filter: jsonArg(args[1]) } : {});
      break;
    case "list-user-profiles":
      out = await request("POST", `/openapi/v1/metadata/${args[0]}/list/user_profiles`, args[1] ? { filter: jsonArg(args[1]) } : {});
      break;
    case "user-profile":
      out = await request("POST", `/openapi/v1/${args[0]}/behaviors/profiles`, { query_type: args[1], query_id: args[2] });
      break;
    case "user-flows":
      out = await request("POST", `/openapi/v1/${args[0]}/behaviors/flows`, {
        query_type: args[1],
        query_id: args[2],
        orientation: args[3] || "earlier",
        timestamp: Number(args[4] || Date.now()),
        count: Number(args[5] || 100),
      });
      break;
    case "user-call-summary": {
      const response = await request("POST", `/openapi/v1/${args[0]}/behaviors/flows`, {
        query_id: args[1],
        query_type: args[2] || "user_unique_id",
        orientation: "earlier",
        count: Number(args[3] || 5000),
        timestamp: Number(args[4] || Date.now()),
      });
      out = summarizeCalls(response);
      break;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
