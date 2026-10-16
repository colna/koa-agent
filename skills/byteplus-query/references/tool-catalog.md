# BytePlus MCP Tool Catalog

This catalog mirrors the tools registered in `src/byteplus/tools.ts`.

## App Lookup

| Tool | Args | Notes |
| --- | --- | --- |
| `byteplus_list_apps` | `keyword?` | Lists all known apps or fuzzy matches by display name, app name, or app id. |

## Raw Event And Export Data

| Tool | Args | Endpoint |
| --- | --- | --- |
| `byteplus_get_data_downloads` | `begin_date`, `end_date`, `app_id` | `GET /openapi/v2/{app_id}/date/{begin_date}/{end_date}/downloads` |
| `byteplus_submit_custom_export` | `begin_date`, `end_date`, `app_id` | `POST /openapi/v1/{app_id}/date/{begin_date}/{end_date}/exports` |
| `byteplus_get_custom_exports` | `app_id` | `GET /openapi/v1/{app_id}/exports` |

## Dashboards And Reports

| Tool | Args | Endpoint |
| --- | --- | --- |
| `byteplus_get_dashboards` | `app_id` | `GET /openapi/v1/{app_id}/dashboards/all` |
| `byteplus_get_dashboard_info` | `dashboard_id`, `app_id` | `GET /openapi/v1/{app_id}/dashboards/{dashboard_id}` |
| `byteplus_get_dashboard_reports` | `dashboard_id`, `app_id` | `GET /openapi/v1/{app_id}/dashboards/{dashboard_id}/reports` |
| `byteplus_get_report_data` | `report_id`, `app_id`, `count?`, `filter_id?` | `GET /openapi/v1/{app_id}/reports/{report_id}` |

## Query Analysis

| Tool | Args | Endpoint |
| --- | --- | --- |
| `byteplus_query_analysis` | `dsl` | `POST /openapi/v1/analysis` |
| `byteplus_get_analysis_result` | `result_id` | `GET /openapi/v1/analysis/{result_id}/result` |
| `byteplus_batch_query_analysis` | `app_id`, `result_id?`, `dsl?` | `POST /openapi/v1/{app_id}/downloads`; send either `result_id` or `dsl`. |

## Cohorts

| Tool | Args | Endpoint |
| --- | --- | --- |
| `byteplus_get_cohorts` | `app_id` | `GET /openapi/v1/{app_id}/cohorts` |
| `byteplus_get_cohort_info` | `cohort_id`, `app_id` | `GET /openapi/v1/{app_id}/cohorts/{cohort_id}` |
| `byteplus_get_cohort_sample` | `cohort_id`, `count`, `app_id` | `GET /openapi/v1/{app_id}/cohorts/{cohort_id}/sample?count=...` |
| `byteplus_download_cohort` | `cohort_id`, `app_id` | `GET /openapi/v1/{app_id}/cohorts/{cohort_id}/download` |
| `byteplus_create_cohort` | `cohort_config`, `app_id` | `POST /openapi/v1/{app_id}/cohorts` |
| `byteplus_refresh_cohort` | `cohort_id`, `app_id` | `GET /openapi/v1/{app_id}/cohorts/{cohort_id}/refresh` |
| `byteplus_delete_cohort` | `cohort_id`, `app_id` | `DELETE /openapi/v1/{app_id}/cohorts/{cohort_id}` |
| `byteplus_update_cohort` | `cohort_id`, `cohort_config`, `app_id` | `PATCH /openapi/v1/{app_id}/cohorts/{cohort_id}` |

## Metadata

| Tool | Args | Endpoint |
| --- | --- | --- |
| `byteplus_get_apps_metadata` | `app_ids`, `with_config?`, `accessed?` | `POST /openapi/v1/metadata/apps` |
| `byteplus_list_events` | `app_id`, `filter?` | `POST /openapi/v1/metadata/{app_id}/list/events` |
| `byteplus_list_event_params` | `app_id`, `filter?` | `POST /openapi/v1/metadata/{app_id}/list/params` |
| `byteplus_list_user_profiles` | `app_id`, `filter?` | `POST /openapi/v1/metadata/{app_id}/list/user_profiles` |

## Tags

| Tool | Args | Endpoint |
| --- | --- | --- |
| `byteplus_get_all_tags` | `app_id` | `GET /openapi/v1/app/{app_id}/tag` |
| `byteplus_get_tag_info` | `tag_name`, `app_id` | `GET /openapi/v1/app/{app_id}/tag/{tag_name}` |
| `byteplus_get_tag_result` | `tag_name`, `app_id` | `GET /openapi/v1/app/{app_id}/tag/{tag_name}/result` |

## Usage

| Tool | Args | Endpoint |
| --- | --- | --- |
| `byteplus_get_usage_monthly` | `app_ids`, `start_time`, `end_time` | `POST /openapi/v1/usage_amount` |
| `byteplus_get_usage_daily` | `app_ids`, `start_time`, `end_time` | `POST /openapi/v1/usage_amount/daily` |

## User Analysis

| Tool | Args | Endpoint |
| --- | --- | --- |
| `byteplus_get_user_profiles` | `query_id`, `query_type`, `app_id` | `POST /openapi/v1/{app_id}/behaviors/profiles` |
| `byteplus_get_user_behavior_flows` | `query_type`, `query_id`, `app_id`, `orientation?`, `timestamp?`, `count?` | `POST /openapi/v1/{app_id}/behaviors/flows` |
