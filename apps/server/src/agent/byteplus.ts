/**
 * BytePlus（DataFinder）查询工具：把 `skills/byteplus-query` 的 CLI 接给 Agent。
 *
 * 背景与参考：
 * - 老项目 `sitin-byteplus-mcp-server` 用 MCP 暴露了 30 个工具（含建/删分群等写操作）；
 *   现在维护中的替代品是 byteplus-query skill 的独立 CLI（AK/SK 签名版 DataFinder
 *   OpenAPI 客户端），本工具直接 spawn 该脚本，只暴露**只读命令集**——写操作
 *   （submit-export / create-cohort 等）不接入，需要时先找维护者确认再加。
 * - 与 SP / SLS 工具同一约定：**永不抛异常**（一切失败转成给模型看的文本）。
 *
 * 凭证（与 skill 脚本行为一致，优先直接 env、其次 dotenv 文件）：
 * - `BYTEPLUS_ACCESS_KEY` / `BYTEPLUS_SECRET_KEY`（必填二者）
 * - `BYTEPLUS_ENV_FILE`：dotenv 文件路径（KEY=VALUE；支持 export 前缀与引号）
 * - `BYTEPLUS_BASE_URL`：可选，默认 https://analytics.byteplusapi.com
 * 凭证缺失时工具返回配置指引（启动时不阻塞、不发网络请求）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { execFileAsync, expandHome, SKILLS_DIR } from './skills.js';

/**
 * 暴露给模型的只读命令集（对齐 byteplus-query CLI，见 skills/byteplus-query/SKILL.md）。
 * 刻意不含：request（通用透传，可能被用来发写请求）、submit-export / 分群增删改（写操作）。
 */
export const BYTEPLUS_READ_COMMANDS = [
    'apps',
    'list-events',
    'list-event-params',
    'list-user-profiles',
    'user-profile',
    'user-flows',
    'user-call-summary',
    'analysis',
    'analysis-result',
    'dashboards',
    'dashboard-info',
    'dashboard-reports',
    'report-data',
    'cohorts',
    'cohort-info',
    'cohort-sample',
    'tags',
    'tag-info',
    'tag-result',
    'usage-daily',
    'usage-monthly',
    'exports',
    'data-downloads',
] as const;

export interface ByteplusToolOptions {
    /** CLI 脚本路径（默认 skills/byteplus-query/scripts/byteplus-query.mjs）。 */
    scriptPath?: string;
    /** node 可执行文件（默认 'node'，从 PATH 找）。 */
    nodeBin?: string;
    /** 凭证：直接传入（优先）。 */
    accessKey?: string;
    secretKey?: string;
    /** API 基址覆盖（可选）。 */
    baseUrl?: string;
    /** 凭证：dotenv 文件路径（其次；支持 ~/ 展开）。 */
    envFile?: string;
    /** 执行超时（毫秒），默认 120s（analysis / 大查询可能较慢）。 */
    timeoutMs?: number;
    /** 输出最大字符数，超出截断（保护模型上下文），默认 40000。 */
    maxOutputChars?: number;
}

/** 解析 dotenv（KEY=VALUE；容忍 `export` 前缀、引号与注释）。 */
export function parseDotenv(content: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith('#')) {
            continue;
        }
        const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (match === null) {
            continue;
        }
        env[match[1] ?? ''] = (match[2] ?? '').trim().replace(/^["']|["']$/g, '');
    }
    return env;
}

/** 组装子进程 env：直接传的凭证优先，其次 dotenv 文件；缺 AK/SK 返回 null。 */
export function resolveByteplusEnv(options: {
    accessKey: string;
    secretKey: string;
    baseUrl: string;
    envFile: string;
}): Record<string, string> | null {
    const env: Record<string, string> = {};
    if (options.accessKey.length > 0) {
        env.BYTEPLUS_ACCESS_KEY = options.accessKey;
    }
    if (options.secretKey.length > 0) {
        env.BYTEPLUS_SECRET_KEY = options.secretKey;
    }
    if (options.baseUrl.length > 0) {
        env.BYTEPLUS_BASE_URL = options.baseUrl;
    }

    if ((env.BYTEPLUS_ACCESS_KEY ?? '').length === 0 && options.envFile.length > 0) {
        try {
            const parsed = parseDotenv(readFileSync(expandHome(options.envFile), 'utf8'));
            for (const [key, value] of Object.entries(parsed)) {
                if (env[key] === undefined) {
                    env[key] = value;
                }
            }
        } catch {
            // 文件不存在 / 不可读：走缺凭证判定
        }
    }

    if (
        (env.BYTEPLUS_ACCESS_KEY ?? '').length === 0 ||
        (env.BYTEPLUS_SECRET_KEY ?? '').length === 0
    ) {
        return null;
    }
    return env;
}

export function createByteplusTool(options: ByteplusToolOptions = {}) {
    const {
        scriptPath = join(SKILLS_DIR, 'byteplus-query', 'scripts', 'byteplus-query.mjs'),
        nodeBin = 'node',
        accessKey = '',
        secretKey = '',
        baseUrl = '',
        envFile = '',
        timeoutMs = 120_000,
        maxOutputChars = 40_000,
    } = options;

    return tool(
        async (input) => {
            // 每次调用重新解析（支持 dotenv 文件热更新；AK 是长期凭证，不涉及续期）
            const env = resolveByteplusEnv({ accessKey, secretKey, baseUrl, envFile });
            if (env === null) {
                return 'BytePlus 凭证未配置：设置 BYTEPLUS_ACCESS_KEY / BYTEPLUS_SECRET_KEY，或让 BYTEPLUS_ENV_FILE 指向含凭证的 dotenv 文件（见 skills/byteplus-query/SKILL.md）。';
            }

            const { stdout, stderr, code } = await execFileAsync(
                nodeBin,
                [scriptPath, input.command, ...input.args],
                env,
                timeoutMs,
            );
            if (code !== 0) {
                const detail = (stderr.trim() || stdout.trim()).slice(0, 600);
                return `BytePlus 查询失败（exit ${code}）：${detail}`;
            }
            const result = stdout.trim();
            if (result.length === 0) {
                return '查询成功，无输出。';
            }
            if (result.length > maxOutputChars) {
                return `${result.slice(0, maxOutputChars)}\n…（输出过长已截断；建议缩小查询范围或加过滤条件）`;
            }
            return result;
        },
        {
            name: 'byteplus_query',
            description:
                '查询 BytePlus（DataFinder）数据分析平台（PWA 应用 app_id=653834）。只读命令集；按命令给位置参数 args。' +
                '常用：apps [关键词]（找 app_id）；list-events <app_id>（事件 schema）；' +
                'user-profile <app_id> user_unique_id <uid>（用户档案）；user-flows <app_id> user_unique_id <uid>（行为流）；' +
                'user-call-summary <app_id> <uid>（PWA 通话汇总；通话数按 room_id 去重）；' +
                "analysis '<dsl-json>'（DSL 分析→拿 result_id 用 analysis-result 取结果）；cohorts <app_id>（分群列表）。" +
                '日期格式 YYYY-MM-DD（usage-daily 需 app_ids_csv + start + end）；原始事件下载仅近 7 天。',
            schema: z.object({
                command: z.enum(BYTEPLUS_READ_COMMANDS).describe('只读子命令'),
                args: z
                    .array(z.string())
                    .default([])
                    .describe(
                        '该命令的位置参数（字符串数组；JSON 参数整体作为一个字符串元素传入）',
                    ),
            }),
        },
    );
}
