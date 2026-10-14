import { z } from 'zod';

const envSchema = z.object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().min(1).default('127.0.0.1'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    OPENAI_API_KEY: z.string().min(1),
    OPENAI_BASE_URL: z.url().default('https://api.openai.com/v1'),
    OPENAI_MODEL: z.string().min(1).default('gpt-4o-mini'),
    AGENT_SQLITE_PATH: z.string().min(1).default('./data/agent.sqlite'),
});

export type Config = z.infer<typeof envSchema>;

export const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export class ConfigError extends Error {}

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
