/**
 * Skill 接入层（方案：skill 索引进 system prompt + 关键操作暴露为工具）。
 *
 * 设计（对应 docs/02 §5 的「skill 即工具 + 索引注入」）：
 * 1. `loadSkills()`：扫描 skills/ 目录，解析每个 SKILL.md 的 YAML frontmatter
 *    （name / description），生成一段「能力索引」拼进 system prompt ——
 *    模型据此知道有什么能力、何时该用（渐进式披露：不把全文塞进 prompt）；
 * 2. `sls-logs` 是可执行 skill：真正查日志由 `sls_query_log` 工具完成 ——
 *    spawn `python3 scripts/sls_query.py`（凭证从 ~/.sls_creds 或 env 读取，
 *    不进仓库）。工具层保持 SP 工具集同一约定：**永不抛异常**，失败转文本。
 *
 * SKILL.md 语法要点被吸收进工具 schema description（方括号短语要加双引号等），
 * 模型不需要先读全文就能正确用。
 */
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

/** skills/ 根目录（monorepo 根，相对本文件定位，避免 CWD 依赖）。 */
export const SKILLS_DIR = join(import.meta.dirname, '../../../..', 'skills');

export interface SkillManifest {
    /** 目录名。 */
    id: string;
    name: string;
    description: string;
    /** frontmatter 原文（name/description 等）。 */
    raw: string;
}

/** 解析 SKILL.md 头部 YAML frontmatter（只用 name/description，不引 YAML 库）。 */
function parseFrontmatter(content: string): SkillManifest['raw'] | null {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    return match?.[1] ?? null;
}

function field(raw: string, key: string): string {
    const match = raw.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return match?.[1]?.trim() ?? '';
}

/** 去掉 description 的引号 / frontmatter 折叠。 */
function cleanDescription(value: string): string {
    return value
        .replace(/^["']|["']$/g, '')
        .replace(/\\n/g, ' ')
        .trim();
}

/** 扫描 skills/ 下所有 SKILL.md，产出 manifest 列表（目录缺 SKILL.md 则跳过）。 */
export function loadSkills(skillsDir: string = SKILLS_DIR): SkillManifest[] {
    let entries: string[] = [];
    try {
        entries = readdirSync(skillsDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
            .map((entry) => entry.name);
    } catch {
        return [];
    }
    const skills: SkillManifest[] = [];
    for (const id of entries) {
        try {
            const content = readFileSync(join(skillsDir, id, 'SKILL.md'), 'utf8');
            const raw = parseFrontmatter(content);
            const name = field(raw ?? '', 'name');
            if (name.length === 0) continue;
            skills.push({
                id,
                name,
                description: cleanDescription(field(raw ?? '', 'description')),
                raw: raw ?? '',
            });
        } catch {
            // 无 SKILL.md 或读失败：跳过
        }
    }
    return skills;
}

/** 把 skill 清单拼成 system prompt 附录段。 */
export function skillsPromptSection(skills: SkillManifest[]): string {
    if (skills.length === 0) return '';
    const lines = skills.map((s) => `- ${s.name}：${s.description}`);
    return [
        '',
        '可用能力（skills）：',
        ...lines,
        '其中 sls-logs 与 byteplus-query 已接入工具（sls_query_log / byteplus_query），直接调工具即可，无需读文件。',
    ].join('\n');
}

export interface SlsToolOptions {
    /** sls_query.py 绝对路径（默认 skills/sls-logs/scripts/sls_query.py）。 */
    scriptPath?: string;
    /** python 可执行文件（默认 /usr/bin/python3，本机 Homebrew python 不可用）。 */
    pythonBin?: string;
    /** 静态凭证 env（~/.sls_creds 解析结果，含 dev 的 endpoint/project/logstore）。 */
    credsEnv?: Record<string, string>;
    /** 动态凭证源：每次调用时解析（优先于 credsEnv）。OAuth 临时 STS 靠它自动续期。 */
    credsProvider?: () => Record<string, string> | Promise<Record<string, string>>;
    /** 线上（prod）环境的 project（env=prod 时覆盖 provider 的 SLS_PROJECT；空=线上不可用）。 */
    prodProject?: string;
    /** 线上（prod）环境的 logstore（env=prod 时覆盖 provider 的 SLS_LOGSTORE）。 */
    prodLogstore?: string;
    /** 执行超时（毫秒），默认 60s。 */
    timeoutMs?: number;
}

export function execFileAsync(
    bin: string,
    args: string[],
    env: Record<string, string>,
    timeoutMs: number,
    cwd?: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve) => {
        execFile(
            bin,
            args,
            {
                // 最小 env + PATH/HOME：凭证按需注入；PATH 找可执行文件；
                // HOME 必须带——aliyun CLI 靠它定位 ~/.aliyun/config.json，
                // 缺失时会把路径解析成 /.aliyun 直接 panic（实测踩坑）。
                env: {
                    ...env,
                    PATH: process.env.PATH ?? '',
                    HOME: process.env.HOME ?? '',
                },
                timeout: timeoutMs,
                maxBuffer: 16 * 1024 * 1024,
                // cwd 可选（如 colna CLI 必须在库根目录下运行）
                ...(cwd !== undefined ? { cwd } : {}),
            },
            (err, stdout, stderr) => {
                const code =
                    err && typeof (err as { code?: number }).code === 'number'
                        ? (err as { code: number }).code
                        : err
                          ? 1
                          : 0;
                resolve({ stdout: String(stdout), stderr: String(stderr), code });
            },
        );
    });
}

export function createSlsLogTool(options: SlsToolOptions = {}) {
    const {
        scriptPath = join(SKILLS_DIR, 'sls-logs', 'scripts', 'sls_query.py'),
        pythonBin = '/usr/bin/python3',
        credsEnv = {},
        credsProvider,
        prodProject = '',
        prodLogstore = '',
        timeoutMs = 60_000,
    } = options;

    return tool(
        async (input) => {
            // 每次调用重新解析凭证（OAuth STS 会过期，需要按需刷新）
            let env: Record<string, string>;
            try {
                env = credsProvider !== undefined ? await credsProvider() : credsEnv;
            } catch (err) {
                return `SLS 查询失败（凭证不可用）：${err instanceof Error ? err.message : String(err)}`;
            }
            // env=prod：用线上 project/logstore 覆盖（endpoint 与 dev 相同，credential 同一套）
            if (input.env === 'prod') {
                if (prodProject.length === 0 || prodLogstore.length === 0) {
                    return 'SLS 线上环境（prod）未配置：设置 SLS_PROJECT_PROD / SLS_LOGSTORE_PROD（见 .env.example），或改用 env=dev。';
                }
                env = { ...env, SLS_PROJECT: prodProject, SLS_LOGSTORE: prodLogstore };
            }

            const args: string[] = [
                scriptPath,
                '--query',
                input.query,
                '--limit',
                String(input.limit),
            ];
            if (input.service !== undefined) args.push('--service', input.service);
            if (input.minutes !== undefined) args.push('--minutes', String(input.minutes));
            if (input.from !== undefined) args.push('--from', input.from);
            if (input.to !== undefined) args.push('--to', input.to);
            if (input.raw) args.push('--raw');
            if (input.reverse) args.push('--reverse');

            const { stdout, stderr, code } = await execFileAsync(pythonBin, args, env, timeoutMs);
            if (code !== 0) {
                const detail = stderr.trim() || stdout.trim();
                // 凭证缺失是最常见失败：附配置指引，模型可直接告知用户
                if (detail.includes('未设置')) {
                    return `SLS 查询失败（凭证缺失）：${detail}\n配置指引：在服务端写 ~/.sls_creds（chmod 600，bash export 格式，含 SLS_ENDPOINT/SLS_PROJECT/SLS_LOGSTORE/SLS_AK_ID/SLS_AK_SECRET，见 skills/sls-logs/SKILL.md），重启服务后重试。`;
                }
                return `SLS 查询失败（exit ${code}）：${detail}`;
            }
            // stderr 是行数统计（--- N rows ---），拼在结果尾部供模型引用；末尾回显环境，防止 dev/prod 结论混淆
            const rows = stderr.trim().split('\n').at(-1) ?? '';
            const result = stdout.trim();
            if (result.length === 0) {
                return rows.length > 0
                    ? `查询成功（环境：${input.env}），无匹配日志（${rows}）。`
                    : `查询成功（环境：${input.env}），无匹配日志。`;
            }
            return `${result}\n\n[${rows}]（环境：${input.env}）`;
        },
        {
            name: 'sls_query_log',
            description:
                '查询阿里云 SLS 日志。env 选环境：dev（默认，测试环境 dev-presence-service-log/dora-dev-stdout）/ prod（线上环境 prod-presence-service-log/dora-prod-stdout）；回答时说明数据来自哪个环境。返回日志行，由你负责阅读并分析（时间模式、错误聚集、链路追踪）。' +
                '语法要点：方括号短语必须加双引号（如 "[AI_CHAT_SERVICE] origin"）；多词空格=AND；字段查询 `字段:值`；' +
                '分析语句在 query 里用 `* | SELECT ...`。时间窗用 minutes/from-to（UTC）。' +
                '常用字段：content=正文、severity=级别、__tag__:_service_name_=服务名（ai-chat-service/aichat-v2/gateway-ws-service…）。',
            schema: z.object({
                env: z
                    .enum(['dev', 'prod'])
                    .default('dev')
                    .describe(
                        "目标环境：'dev'（默认，测试环境）/ 'prod'（线上环境）；查询前与回答中都要明确环境",
                    ),
                query: z
                    .string()
                    .default('*')
                    .describe('SLS 查询/分析语句，默认 *；方括号短语要加双引号'),
                service: z
                    .string()
                    .optional()
                    .describe('按服务名快捷过滤（__tag__:_service_name_）'),
                minutes: z
                    .number()
                    .int()
                    .min(1)
                    .max(20_160)
                    .optional()
                    .describe('最近 N 分钟（与 from/to 二选一）'),
                from: z.string().optional().describe("起始时间 'YYYY-MM-DD HH:MM:SS'（UTC）"),
                to: z.string().optional().describe("结束时间 'YYYY-MM-DD HH:MM:SS'（UTC）"),
                limit: z.number().int().min(1).max(1000).default(100).describe('最多返回行数'),
                reverse: z.boolean().default(false).describe('最新在前'),
                raw: z.boolean().default(false).describe('输出原始 JSON（做统计/下游处理时用）'),
            }),
        },
    );
}

/**
 * 展开 `~/` 前缀为 HOME（不支持 `~user` 形式，够用）。
 */
export function expandHome(path: string): string {
    return path.startsWith('~/') ? join(process.env.HOME ?? '', path.slice(2)) : path;
}

/**
 * 解析 ~/.sls_creds（bash export 语法）→ env 键值对。
 * 路径支持 `~/` 前缀（展开为 HOME）。文件不存在或必填键缺失时返回 null
 * （调用方决定 fail-fast 或留空让工具报指引）。
 */
export function loadSlsCreds(credsPath: string): Record<string, string> | null {
    const path = expandHome(credsPath);
    try {
        const content = readFileSync(path, 'utf8');
        const env: Record<string, string> = {};
        for (const line of content.split('\n')) {
            const match = line.match(/^export\s+([A-Z_]+)=(.*)$/);
            if (match) {
                env[match[1] ?? ''] = (match[2] ?? '').trim().replace(/^["']|["']$/g, '');
            }
        }
        const required = [
            'SLS_ENDPOINT',
            'SLS_PROJECT',
            'SLS_LOGSTORE',
            'SLS_AK_ID',
            'SLS_AK_SECRET',
        ];
        return required.every((k) => (env[k] ?? '').length > 0) ? env : null;
    } catch {
        return null;
    }
}

/** `~/.aliyun/config.json` 里 profile 的关键字段（只列本模块用到的）。 */
interface AliyunProfile {
    name: string;
    access_key_id?: string;
    access_key_secret?: string;
    sts_token?: string;
    /** Unix 秒。 */
    sts_expiration?: number;
}

export interface AliyunOAuthCredsOptions {
    /** `aliyun configure --mode OAuth --profile <名>` 的 profile 名。 */
    profile: string;
    /** config.json 路径，默认 `~/.aliyun/config.json`（~/ 展开）。 */
    configPath?: string;
    /** aliyun CLI 可执行文件，默认 `aliyun`（从 PATH 找）。 */
    aliyunBin?: string;
    /** 剩余有效期低于该值就触发刷新，默认 5 分钟。 */
    refreshSkewMs?: number;
    /** 测试注入：执行外部命令（默认真实 execFileAsync）。 */
    execFileFn?: typeof execFileAsync;
    /** 测试注入：当前时间（毫秒）。 */
    now?: () => number;
}

/**
 * 从阿里云 CLI OAuth profile 读取临时 STS 凭证，转成 sls_query.py 需要的 env
 * （SLS_AK_ID / SLS_AK_SECRET / SLS_STS_TOKEN）。
 *
 * 续期机制：OAuth 的 STS 默认 3 小时过期。每次解析时检查 config.json 的
 * `sts_expiration`，临期（默认剩余 <5 分钟）就跑一次轻量 API（sts GetCallerIdentity）——
 * aliyun CLI 会用 refresh token 自动换发新凭证并写回 config.json，我们再重新读取。
 * 刷新失败时：旧凭证未过期则继续用（下次调用再试）；已过期则如实抛错。
 */
export async function loadAliyunOAuthCreds(
    options: AliyunOAuthCredsOptions,
): Promise<Record<string, string>> {
    const {
        profile,
        configPath = '~/.aliyun/config.json',
        aliyunBin = 'aliyun',
        refreshSkewMs = 300_000,
        execFileFn = execFileAsync,
        now = Date.now,
    } = options;
    const path = expandHome(configPath);

    const readProfile = (): AliyunProfile | null => {
        try {
            const data = JSON.parse(readFileSync(path, 'utf8')) as { profiles?: AliyunProfile[] };
            return data.profiles?.find((item) => item.name === profile) ?? null;
        } catch {
            return null;
        }
    };

    let prof = readProfile();
    if (prof === null) {
        throw new Error(
            `aliyun profile "${profile}" 不存在（${path}）。先运行：aliyun configure --mode OAuth --profile ${profile}`,
        );
    }

    const expiresAtMs = (prof.sts_expiration ?? 0) * 1000;
    if (expiresAtMs - now() < refreshSkewMs) {
        const { code, stderr, stdout } = await execFileFn(
            aliyunBin,
            ['sts', 'GetCallerIdentity', '--profile', profile],
            {},
            30_000,
        );
        if (code === 0) {
            prof = readProfile() ?? prof;
        } else if (expiresAtMs <= now()) {
            const detail = (stderr.trim() || stdout.trim()).slice(0, 300);
            throw new Error(`aliyun 凭证刷新失败：${detail}`);
        }
    }

    const { access_key_id: id, access_key_secret: secret, sts_token: token } = prof;
    if (!id || !secret || !token) {
        throw new Error(
            `aliyun profile "${profile}" 缺少 STS 凭证字段，重新配置：aliyun configure --mode OAuth --profile ${profile}`,
        );
    }
    return { SLS_AK_ID: id, SLS_AK_SECRET: secret, SLS_STS_TOKEN: token };
}
