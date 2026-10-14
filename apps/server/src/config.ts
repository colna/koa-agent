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
    SP_ADMIN_BASE_URL: z.url().default('https://admin-api-dev.sitin.ai'),
    /** 自签 minerva JWT；留空则 SP 工具返回配置指引（不阻塞启动）。 */
    SP_ADMIN_TOKEN: z.string().default(''),
    /** 报表 / CSV 导出的落盘目录（相对 server 工作目录）。 */
    SP_REPORT_DIR: z.string().min(1).default('./data/reports'),
    OPENAI_API_KEY: z.string().min(1),
    OPENAI_BASE_URL: z.url().default('https://api.openai.com/v1'),
    OPENAI_MODEL: z.string().min(1).default('gpt-4o-mini'),
    AGENT_SQLITE_PATH: z.string().min(1).default('./data/agent.sqlite'),
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
