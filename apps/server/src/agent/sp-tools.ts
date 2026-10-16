/**
 * SP Agent 工具集：发 signal / 报错分析 / 报表 / 在线分析。
 *
 * 接口来源（sitin-next `feature/sp` 勘察结论，经 minerva BFF）：
 * - 信号下发：`POST /api/social-proxy/v3/admin/signal/create`（内层业务结果 `{success, signal|error}`；
 *   60s 去重命中时 `signal === null`）；
 * - 错误日志：`GET /api/social-proxy/script/error-logs`（过滤 creatorId/action/errorCode/日期，pageSize ≤2000；
 *   **无聚合接口**，聚合在本文件内完成）+ `.../export`（CSV 流式）；
 * - 在线：`GET /api/social-proxy/gateway/devices`（实时）+ `/api/sp-online/{summary,timeseries}`（历史）；
 * - v3 看板：`GET /api/social-proxy/v3/dashboard/{overview,creators,funnel,latency,anomalies,trace}`。
 *
 * 三个贯穿性约定：
 * 1. 工具**永不抛异常** —— 一切失败转成给模型看的文本（模型可以纠正/告知用户），不中断图；
 * 2. **双环境**：每个工具带 `env` 参数（'dev' 默认 / 'prod' 线上），由 `clientFor()` 路由到
 *    对应的 SpAdminClient；线上未配置（SP_ADMIN_TOKEN_PROD 为空）时返回配置指引文本；
 * 3. `sp_send_signal` 是**双步确认**：confirm=false 只返回待确认摘要（不发请求，含目标环境），
 *    用户明确同意后再以 confirm=true 调用 —— 人工闸门在工具层实现（ADR 见 docs/04）。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { type SpAdminClient, SpClientError } from '../sp/client.js';

/** SignalType 全量（sitin-next `signal.entity.ts`，15 个）。 */
export const SIGNAL_TYPES = [
    'CE_EXCHANGED',
    'IG_DM_RECEIVED',
    'IG_FOLLOW_RECEIVED',
    'CREATOR_ONBOARDED',
    'KEEPALIVE_TICK',
    'REFLOW_TRIGGER',
    'INBOX_CHECK_TRIGGER',
    'INBOX_CHECKED',
    'FOLLOW_BACK_COMPLETED',
    'TODO_FAILED',
    'IG_ACCOUNT_RESTRICTED',
    'PROFILE_SYNC_NEEDED',
    'IG_NEW_MESSAGE',
    'IG_TO_PROFESSIONAL',
    'PUBLISH_POST_REQUESTED',
] as const;

export interface SpToolsOptions {
    /** 默认（dev）环境 client。 */
    client: SpAdminClient;
    /** 线上（prod）环境 client；未配置（null/undefined）时 env=prod 的调用返回配置指引。 */
    prodClient?: SpAdminClient | null;
    /** 报表 / CSV 导出落盘目录。 */
    reportDir: string;
    /** 报表下载链接前缀（如 http://127.0.0.1:3000）。 */
    serverBaseUrl: string;
}

/** 目标环境：dev（默认，测试环境）/ prod（线上环境）。 */
export const SP_ENVS = ['dev', 'prod'] as const;
export type SpEnv = (typeof SP_ENVS)[number];

/** 线上未配置时的统一指引文案（工具转文本返回，不抛异常）。 */
const MISSING_PROD_HINT =
    'SP 线上环境（prod）未配置：请在 apps/server/.env 设置 SP_ADMIN_TOKEN_PROD（线上 admin 后台的 sessionToken），重启后重试；或改用 env=dev（默认）。';

/** 所有 SP 工具共用的 env 字段定义。 */
const envField = z
    .enum(SP_ENVS)
    .default('dev')
    .describe(
        "目标环境：'dev'（默认，测试环境）/ 'prod'（线上环境；需配置 SP_ADMIN_TOKEN_PROD，查询前务必与用户确认是哪个环境）",
    );

/** 错误日志条目（Prisma 模型字段，JSON 为 camelCase）。 */
interface ErrorLogItem {
    id: string;
    creatorId: string;
    action: string;
    errorCode: string;
    message: string;
    selector?: string | null;
    durationMs?: number | null;
    createdAt: string;
}

const MAX_PAGE_SIZE = 2000;
const PAGE_LIMIT = 10; // 防御：最多翻 10 页（2 万条）

function spErrorText(err: unknown): string {
    if (err instanceof SpClientError) {
        return `SP 调用失败（${err.kind}）：${err.message}`;
    }
    return `SP 工具异常：${err instanceof Error ? err.message : String(err)}`;
}

/** 把时间戳格式化为指定时区的 YYYY-MM-DD（en-CA locale 正好是 ISO 日期）。 */
function dateInTimezone(offsetDays: number, timeZone: string): string {
    const date = new Date(Date.now() + offsetDays * 86_400_000);
    return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(date);
}

/** 日期过滤默认值：缺省最近 7 天（闭区间）。 */
function withDefaultRange<T extends { startDate?: string; endDate?: string }>(
    input: T,
): T & { startDate: string; endDate: string } {
    return {
        ...input,
        startDate: input.startDate ?? new Date(Date.now() - 7 * 86_400_000).toISOString(),
        endDate: input.endDate ?? new Date().toISOString(),
    };
}

/** 拉取错误日志（自动翻页，直到 total / maxRecords / 页上限）。 */
async function fetchErrorLogs(
    client: SpAdminClient,
    filter: {
        creatorId?: string;
        action?: string;
        errorCode?: string;
        startDate: string;
        endDate: string;
    },
    maxRecords: number,
): Promise<{ items: ErrorLogItem[]; total: number }> {
    const items: ErrorLogItem[] = [];
    let total = 0;

    for (let page = 1; page <= PAGE_LIMIT; page += 1) {
        const data = await client.request<{ items?: ErrorLogItem[]; total: number }>({
            path: '/api/social-proxy/script/error-logs',
            query: { ...filter, page, pageSize: MAX_PAGE_SIZE },
        });
        total = data.total;
        const batch = data.items ?? [];
        items.push(...batch);
        if (batch.length < MAX_PAGE_SIZE || items.length >= Math.min(total, maxRecords)) {
            break;
        }
    }

    return { items: items.slice(0, maxRecords), total };
}

/** 按动作 / 错误码 / 日期三个维度计数，输出降序统计。 */
function aggregate(items: ErrorLogItem[]): {
    byAction: [string, number][];
    byErrorCode: [string, number][];
    byDay: [string, number][];
} {
    const byAction = new Map<string, number>();
    const byErrorCode = new Map<string, number>();
    const byDay = new Map<string, number>();

    for (const item of items) {
        byAction.set(item.action, (byAction.get(item.action) ?? 0) + 1);
        byErrorCode.set(item.errorCode, (byErrorCode.get(item.errorCode) ?? 0) + 1);
        const day = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(new Date(item.createdAt));
        byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }

    const desc = (map: Map<string, number>): [string, number][] =>
        [...map.entries()].sort((a, b) => b[1] - a[1]);
    return {
        byAction: desc(byAction),
        byErrorCode: desc(byErrorCode),
        byDay: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    };
}

function trimSample(item: ErrorLogItem) {
    return {
        createdAt: item.createdAt,
        creatorId: item.creatorId,
        action: item.action,
        errorCode: item.errorCode,
        message: item.message.slice(0, 200),
        selector: item.selector ?? null,
        durationMs: item.durationMs ?? null,
    };
}

const errorFilterShape = {
    env: envField,
    startDate: z.string().optional().describe('ISO 8601 下界（闭区间）；缺省=近 7 天'),
    endDate: z.string().optional().describe('ISO 8601 上界（闭区间）；缺省=当前'),
    creatorId: z.string().optional().describe('创作者 ID（精确匹配）'),
    action: z
        .string()
        .optional()
        .describe('脚本动作名，如 getProfilePostImage / getChatMessages / followUserById'),
    errorCode: z
        .string()
        .optional()
        .describe('错误码，如 ELEMENT_NOT_FOUND / INVALID_PARAMS / SESSION_LOST'),
};

export function createSpTools(options: SpToolsOptions) {
    const { client, prodClient = null, reportDir, serverBaseUrl } = options;

    /** env → client；prod 未配置返回 null（调用方转成配置指引文案）。 */
    function clientFor(env: SpEnv): SpAdminClient | null {
        return env === 'prod' ? prodClient : client;
    }

    /** 构造只含接口需要的过滤字段（不把 env / maxRecords 等本地字段透传给 BFF）。 */
    function errorFilter(input: {
        creatorId?: string | undefined;
        action?: string | undefined;
        errorCode?: string | undefined;
        startDate?: string | undefined;
        endDate?: string | undefined;
    }) {
        return withDefaultRange({
            creatorId: input.creatorId,
            action: input.action,
            errorCode: input.errorCode,
            startDate: input.startDate,
            endDate: input.endDate,
        });
    }

    const queryScriptErrors = tool(
        async (input) => {
            try {
                const activeClient = clientFor(input.env);
                if (activeClient === null) {
                    return MISSING_PROD_HINT;
                }
                const filter = errorFilter(input);
                const { items, total } = await fetchErrorLogs(
                    activeClient,
                    filter,
                    input.maxRecords,
                );
                const aggregated = aggregate(items);
                return JSON.stringify(
                    {
                        环境: input.env,
                        时间范围: { startDate: filter.startDate, endDate: filter.endDate },
                        总条数: total,
                        本次拉取: items.length,
                        按Action: aggregated.byAction,
                        按错误码: aggregated.byErrorCode,
                        按日: aggregated.byDay,
                        最新样本: items.slice(0, 5).map(trimSample),
                        提示: '统计为原始口径；噪声归类（空 profile、NO_UNREAD 等）需结合样本判断',
                    },
                    null,
                    2,
                );
            } catch (err) {
                return spErrorText(err);
            }
        },
        {
            name: 'sp_query_script_errors',
            description:
                '查询 SP 脚本错误日志并返回聚合统计（按 Action / 错误码 / 日期）+ 最新样本 5 条。用于报错分析。缺省最近 7 天。env 选环境：dev（默认）/ prod（线上）。',
            schema: z.object({
                ...errorFilterShape,
                maxRecords: z
                    .number()
                    .int()
                    .min(1)
                    .max(10_000)
                    .default(5000)
                    .describe('最多拉取条数（翻页聚合用）'),
            }),
        },
    );

    const buildErrorReport = tool(
        async (input) => {
            try {
                const activeClient = clientFor(input.env);
                if (activeClient === null) {
                    return MISSING_PROD_HINT;
                }
                const filter = errorFilter(input);
                const { items, total } = await fetchErrorLogs(
                    activeClient,
                    filter,
                    input.maxRecords,
                );
                const { byAction, byErrorCode, byDay } = aggregate(items);
                const pct = (count: number) =>
                    items.length > 0 ? ` (${((count / items.length) * 100).toFixed(1)}%)` : '';

                const table = (title: string, rows: [string, number][], withPct: boolean) =>
                    [
                        `### ${title}`,
                        '',
                        '| 维度 | 条数 |',
                        '|---|---:|',
                        ...rows
                            .slice(0, 20)
                            .map(
                                ([key, count]) =>
                                    `| ${key} | ${count}${withPct ? pct(count) : ''} |`,
                            ),
                        '',
                    ].join('\n');

                const lines = [
                    `# SP 脚本错误报表（环境：${input.env}）`,
                    '',
                    `- 环境：${input.env}（dev=测试 / prod=线上）`,
                    `- 时间范围：${filter.startDate} ~ ${filter.endDate}（时间为 Asia/Shanghai 解读）`,
                    `- 总条数：${total}（本次拉取并统计 ${items.length} 条${total > items.length ? '，仅统计拉取部分' : ''}）`,
                    '',
                    table('按 Action', byAction, true),
                    table('按错误码', byErrorCode, true),
                    table('按日分布', byDay, false),
                    '### 最新 5 条样本',
                    '',
                    ...items
                        .slice(0, 5)
                        .map(
                            (item) =>
                                `- ${item.createdAt} | ${item.action} | ${item.errorCode} | ${item.message.slice(0, 120)}`,
                        ),
                    '',
                    '> 说明：以上为统计口径汇总；噪声归类（空 profile、NO_UNREAD、脏 handle 等）需结合样本与知识库归因方法进一步判断。',
                ];
                return lines.join('\n');
            } catch (err) {
                return spErrorText(err);
            }
        },
        {
            name: 'sp_build_error_report',
            description:
                '生成 SP 脚本错误 Markdown 报表（总量 + 按 Action/错误码/日期表格 + 样本）。适合用户要“出一份报表”时使用；缺省最近 7 天。',
            schema: z.object({
                ...errorFilterShape,
                maxRecords: z.number().int().min(1).max(10_000).default(5000),
            }),
        },
    );

    const exportErrorsCsv = tool(
        async (input) => {
            try {
                const activeClient = clientFor(input.env);
                if (activeClient === null) {
                    return MISSING_PROD_HINT;
                }
                const filter = errorFilter(input);
                mkdirSync(reportDir, { recursive: true });
                const now = new Date();
                const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
                    now.getDate(),
                ).padStart(
                    2,
                    '0',
                )}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(
                    now.getSeconds(),
                ).padStart(2, '0')}`;
                const fileName = `script-errors_${input.env}_${stamp}.csv`;
                const bytes = await activeClient.downloadToFile(
                    {
                        path: '/api/social-proxy/script/error-logs/export',
                        query: filter,
                    },
                    join(reportDir, fileName),
                );
                return JSON.stringify(
                    {
                        status: 'exported',
                        环境: input.env,
                        文件: fileName,
                        字节数: bytes,
                        下载链接: `${serverBaseUrl}/sp/reports/${fileName}`,
                        时间范围: { startDate: filter.startDate, endDate: filter.endDate },
                    },
                    null,
                    2,
                );
            } catch (err) {
                return spErrorText(err);
            }
        },
        {
            name: 'sp_export_script_errors_csv',
            description:
                '把 SP 脚本错误日志导出为 CSV 文件（服务端流式落盘），返回下载链接。适合用户要“导出数据/附件”。缺省最近 7 天。env 选环境：dev（默认）/ prod（线上）。',
            schema: z.object(errorFilterShape),
        },
    );

    const onlineOverview = tool(
        async (input) => {
            try {
                const activeClient = clientFor(input.env);
                if (activeClient === null) {
                    return MISSING_PROD_HINT;
                }
                const timezone = input.timezone ?? 'Asia/Shanghai';
                const startDate = input.startDate ?? dateInTimezone(-6, timezone);
                const endDate = input.endDate ?? dateInTimezone(0, timezone);

                const [devices, summary, timeseries] = await Promise.all([
                    activeClient.request<{
                        devices?: { creatorId: string; connectedAt: number }[];
                        count?: number;
                    }>({ path: '/api/social-proxy/gateway/devices' }),
                    activeClient.request({
                        path: '/api/sp-online/summary',
                        query: { startDate, endDate, timezone },
                    }),
                    activeClient.request({
                        path: '/api/sp-online/timeseries',
                        query: { startDate, endDate, timezone },
                    }),
                ]);

                const deviceList = devices.devices ?? [];
                return JSON.stringify(
                    {
                        环境: input.env,
                        时间范围: { startDate, endDate, timezone },
                        实时网关设备: {
                            在线数: devices.count ?? deviceList.length,
                            设备样本: deviceList.slice(0, 10),
                            说明: '来自 gateway 内存表（单实例口径）',
                        },
                        历史在线汇总: summary,
                        每小时在线趋势: timeseries,
                    },
                    null,
                    2,
                );
            } catch (err) {
                return spErrorText(err);
            }
        },
        {
            name: 'sp_online_overview',
            description:
                'SP 在线分析：实时网关设备数 + 历史在线汇总（总用户/总时长/中位时长）+ 每小时在线趋势。缺省近 7 天、Asia/Shanghai。env 选环境：dev（默认）/ prod（线上）。',
            schema: z.object({
                env: envField,
                startDate: z.string().optional().describe('YYYY-MM-DD，缺省=近 7 天'),
                endDate: z.string().optional().describe('YYYY-MM-DD（含当天），缺省=今天'),
                timezone: z.string().optional().describe('IANA 时区，缺省 Asia/Shanghai'),
            }),
        },
    );

    const dashboardQuery = tool(
        async (input) => {
            try {
                if (input.query === 'trace' && (input.creatorId ?? '').length === 0) {
                    return '错误：trace 查询必须提供 creatorId';
                }
                const activeClient = clientFor(input.env);
                if (activeClient === null) {
                    return MISSING_PROD_HINT;
                }
                const data = await activeClient.request<unknown>({
                    path: `/api/social-proxy/v3/dashboard/${input.query}`,
                    query: {
                        creatorId: input.creatorId,
                        hours: input.hours,
                        threshold: input.threshold,
                    },
                });
                return JSON.stringify({ query: input.query, env: input.env, data }, null, 2);
            } catch (err) {
                return spErrorText(err);
            }
        },
        {
            name: 'sp_dashboard_query',
            description:
                '查询 SP v3 链路看板：overview（今日信号/任务计数）、creators（创作者聚合）、funnel（转化漏斗）、latency（耗时 P50/95/99）、anomalies（失败率异常）、trace（单创作者 Signal→Todo→Behavior 链路，需 creatorId）。env 选环境：dev（默认）/ prod（线上）。',
            schema: z.object({
                query: z.enum(['overview', 'creators', 'funnel', 'latency', 'anomalies', 'trace']),
                env: envField,
                creatorId: z.string().optional().describe('trace 必填'),
                hours: z
                    .number()
                    .int()
                    .min(1)
                    .max(168)
                    .optional()
                    .describe('时间窗（小时），funnel/latency/anomalies/trace 用'),
                threshold: z
                    .number()
                    .min(1)
                    .max(100)
                    .optional()
                    .describe('anomalies 失败率阈值（%），默认 20'),
            }),
        },
    );

    const sendSignal = tool(
        async (input) => {
            const activeClient = clientFor(input.env);
            if (activeClient === null) {
                return MISSING_PROD_HINT;
            }

            const summary = {
                环境: input.env,
                type: input.type,
                creatorId: input.creatorId,
                userId: input.userId ?? null,
                payload: input.payload ?? {},
            };

            // 第一步：只回摘要，不发请求 —— 等用户明确同意（人工闸门）
            if (!input.confirm) {
                return JSON.stringify(
                    {
                        status: 'pending_confirmation',
                        待发送信号: summary,
                        下一步:
                            '先向用户复述上述信号内容（务必明示目标环境：dev=测试 / prod=线上）并请求明确同意；' +
                            '用户同意后，再以 confirm=true（保持同一 env）调用本工具一次。严禁未经用户同意直接 confirm。',
                    },
                    null,
                    2,
                );
            }

            try {
                const data = await activeClient.request<{
                    success: boolean;
                    signal?: { id: string } | null;
                    error?: string;
                }>({
                    method: 'POST',
                    path: '/api/social-proxy/v3/admin/signal/create',
                    body: {
                        type: input.type,
                        creatorId: input.creatorId,
                        userId: input.userId,
                        payload: input.payload ?? {},
                        ...(input.dedupeKey !== undefined ? { dedupeKey: input.dedupeKey } : {}),
                    },
                });

                if (data.success && data.signal) {
                    return JSON.stringify({ status: 'sent', signalId: data.signal.id, ...summary });
                }
                if (data.success && !data.signal) {
                    return JSON.stringify({
                        status: 'deduped',
                        说明: '60s 内相同信号被去重（未新建）；如需强制重发可稍后重试或自定义 dedupeKey',
                        ...summary,
                    });
                }
                return `SP 拒绝下发：${data.error ?? '未知原因'}`;
            } catch (err) {
                return spErrorText(err);
            }
        },
        {
            name: 'sp_send_signal',
            description:
                '向 SP 下发信号（双步确认：第一次调用返回待确认摘要，用户同意后再以 confirm=true 调用）。' +
                'env 选环境：dev（默认）/ prod（线上，需配置 SP_ADMIN_TOKEN_PROD）—— 向线上下发前必须在复述中明示「线上」。' +
                '会触发动作的常用类型：' +
                'CE_EXCHANGED（需 payload.userIgHandle + isFirstContact:true + userId）、IG_DM_RECEIVED（需 userId 才回复）、' +
                'PROFILE_SYNC_NEEDED（需 payload.creatorIgHandle）、IG_NEW_MESSAGE（空 payload）。' +
                'KEEPALIVE_TICK 等审计类不触发下游动作，适合联调。',
            schema: z.object({
                type: z.enum(SIGNAL_TYPES).describe('信号类型'),
                env: envField,
                creatorId: z.string().min(1).describe('创作者 ID（下游按 creator 调度）'),
                userId: z
                    .string()
                    .optional()
                    .describe('用户 ID（CE_EXCHANGED / IG_DM_RECEIVED 建议携带）'),
                payload: z
                    .record(z.string(), z.unknown())
                    .optional()
                    .describe('信号负载（字段随类型不同）'),
                confirm: z.boolean().default(false).describe('用户明确同意后才可为 true'),
                dedupeKey: z
                    .string()
                    .optional()
                    .describe('自定义去重键（默认 admin:<type>:<creatorId>:<ts>）'),
            }),
        },
    );

    return {
        sendSignal,
        queryScriptErrors,
        buildErrorReport,
        exportErrorsCsv,
        onlineOverview,
        dashboardQuery,
    };
}
