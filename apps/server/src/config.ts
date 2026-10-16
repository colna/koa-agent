/**
 * 环境配置模块：启动时一次性校验全部环境变量（fail-fast）。
 *
 * 设计要点（对应测试 src/config.test.ts）：
 * - 缺失 / 非法配置在「启动阶段」就报错，而不是拖到第一个请求才炸；
 * - loadConfig 接收 env 参数（默认 process.env），测试可传任意假对象，
 *   无需污染真实环境变量；
 * - 报错信息聚合全部问题，一次看到所有要修的点。
 */
import { z } from 'zod';

/**
 * env 的 schema 即「配置契约」：既做运行时校验，又通过 z.infer 生成类型。
 *
 * 几个容易踩的点：
 * - `z.coerce.number()`：环境变量天然是字符串，`"8080"` 要先转数字再校验范围；
 * - 故意**不**用 `.strict()`：process.env 里充满无关变量（PATH、HOME…），
 *   strict 会把它们当非法字段报错；
 * - `z.url()` 是 zod v4 的顶层格式校验；`default()` 让可选配置缺失时自动补默认值；
 * - `OPENAI_API_KEY` 没有 default —— 必填项，缺失或空串都会让后面 safeParse 失败。
 */
const envSchema = z.object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().min(1).default('127.0.0.1'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    CORS_ORIGIN: z.string().min(1).default('*'),
    // ---- SP Agent（minerva BFF）----
    /** dev（默认）环境：base + token。 */
    SP_ADMIN_BASE_URL: z.url().default('https://admin-api-dev.sitin.ai'),
    /** 自签 minerva JWT；留空则 SP 工具返回配置指引（不阻塞启动）。 */
    SP_ADMIN_TOKEN: z.string().default(''),
    /** prod（线上）环境：token 留空则 env=prod 的查询返回配置指引（工具带 env 参数区分环境）。 */
    SP_ADMIN_BASE_URL_PROD: z.url().default('https://admin-api-prod.sitin.ai'),
    SP_ADMIN_TOKEN_PROD: z.string().default(''),
    /** 报表 / CSV 导出的落盘目录（相对 server 工作目录）。 */
    SP_REPORT_DIR: z.string().min(1).default('./data/reports'),
    // ---- SLS 日志查询（sls-logs skill）----
    /** 查询脚本 python（本机 Homebrew python 不可用，默认系统 python3）。 */
    SLS_PYTHON_BIN: z.string().min(1).default('/usr/bin/python3'),
    /** SLS 连接信息（与 sls-logs SKILL.md 预置一致；文件凭证模式下可被 ~/.sls_creds 覆盖）。 */
    SLS_ENDPOINT: z.string().min(1).default('us-west-1.log.aliyuncs.com'),
    SLS_PROJECT: z.string().min(1).default('dev-presence-service-log'),
    SLS_LOGSTORE: z.string().min(1).default('dora-dev-stdout'),
    /** 线上（prod）环境（env=prod 时使用；与 dev 同账号、同 endpoint）。 */
    SLS_PROJECT_PROD: z.string().default('prod-presence-service-log'),
    SLS_LOGSTORE_PROD: z.string().default('dora-prod-stdout'),
    /** 静态凭证文件路径；支持 ~/ 前缀（HOME 展开）。 */
    SLS_CREDS_PATH: z.string().min(1).default('~/.sls_creds'),
    /** 阿里云 CLI OAuth profile 名（设置后走动态 STS 凭证并自动续期；空 = 用静态凭证文件）。 */
    SLS_ALIYUN_PROFILE: z.string().default(''),
    /** aliyun CLI 的 config.json 路径（~/ 展开）。 */
    SLS_ALIYUN_CONFIG_PATH: z.string().min(1).default('~/.aliyun/config.json'),
    /** aliyun CLI 可执行文件（PATH 找不到时给绝对路径，如 /opt/homebrew/bin/aliyun）。 */
    SLS_ALIYUN_BIN: z.string().min(1).default('aliyun'),
    // ---- BytePlus（DataFinder）查询（byteplus-query skill）----
    /** node 可执行文件（PATH 找不到时给绝对路径）。 */
    BYTEPLUS_NODE_BIN: z.string().min(1).default('node'),
    /** 凭证其一：直接给 AK/SK；留空则从 BYTEPLUS_ENV_FILE 的 dotenv 读取。 */
    BYTEPLUS_ACCESS_KEY: z.string().default(''),
    BYTEPLUS_SECRET_KEY: z.string().default(''),
    /** 凭证其二：dotenv 文件路径（KEY=VALUE），支持 ~/ 展开。 */
    BYTEPLUS_ENV_FILE: z.string().default(''),
    /** API 基址覆盖（默认 https://analytics.byteplusapi.com）。 */
    BYTEPLUS_BASE_URL: z.string().default(''),
    // ---- 知识库检索（RAG，colna-memo）----
    /** colna-memo 根目录（含 ./colna CLI 与 memory/）；留空则不注册 kb_search/kb_read。 */
    KB_MEMO_DIR: z.string().default(''),
    OPENAI_API_KEY: z.string().min(1),
    OPENAI_BASE_URL: z.url().default('https://api.openai.com/v1'),
    OPENAI_MODEL: z.string().min(1).default('gpt-4o-mini'),
    AGENT_SQLITE_PATH: z.string().min(1).default('./data/agent.sqlite'),
    /** 送模型的上下文 token 预算（粗略估算）；超出的旧轮次不进模型输入。 */
    AGENT_MAX_INPUT_TOKENS: z.coerce.number().int().min(1000).max(1_000_000).default(48_000),
});

/** 由 schema 推导出的配置类型：业务代码只依赖它，不直接碰 process.env。 */
export type Config = z.infer<typeof envSchema>;

/**
 * threadId 合法格式：字母数字开头，后接字母数字 / 下划线 / 连字符，总长 1~128。
 * 放在 config 里是因为「路由校验入参」与「测试」都要用，避免两处定义漂移。
 */
export const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** 配置专用错误类型：与「业务运行错误」区分，入口层可据此给出不同处理（打印后退出）。 */
export class ConfigError extends Error {}

/**
 * 校验并返回配置。用法：main() 启动时调用一次，之后全程传递 Config 对象。
 * safeParse 不抛异常，让我们能把所有 issue 聚合成一条人类可读的报错。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const result = envSchema.safeParse(env);
    if (!result.success) {
        const lines = result.error.issues.map(
            (issue) => `- ${issue.path.join('.') || '(env)'}: ${issue.message}`,
        );
        throw new ConfigError(`环境配置校验失败：\n${lines.join('\n')}`);
    }
    return result.data;
}
