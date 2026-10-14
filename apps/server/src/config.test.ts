/**
 * config.ts 单元测试：必填缺失 / 空串 / 默认值 / 非法 PORT、URL、NODE_ENV，
 * 以及 threadId 命名规则。全部通过 loadConfig(假 env 对象) 完成，不读真实环境变量。
 */
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, THREAD_ID_PATTERN } from './config.js';

const baseEnv = { OPENAI_API_KEY: 'sk-test' };

describe('loadConfig', () => {
    it('缺失 OPENAI_API_KEY 时抛 ConfigError 并点名变量', () => {
        expect(() => loadConfig({})).toThrow(ConfigError);
        expect(() => loadConfig({})).toThrow(/OPENAI_API_KEY/);
    });

    it('空字符串 OPENAI_API_KEY 视为缺失', () => {
        expect(() => loadConfig({ ...baseEnv, OPENAI_API_KEY: '' })).toThrow(/OPENAI_API_KEY/);
    });

    it('最小环境应用全部默认值', () => {
        const config = loadConfig({ ...baseEnv });
        expect(config.PORT).toBe(3000);
        expect(typeof config.PORT).toBe('number');
        expect(config.HOST).toBe('127.0.0.1');
        expect(config.NODE_ENV).toBe('development');
        expect(config.CORS_ORIGIN).toBe('*');
        expect(config.SP_ADMIN_BASE_URL).toBe('https://admin-api-dev.sitin.ai');
        expect(config.SP_ADMIN_TOKEN).toBe('');
        expect(config.SP_REPORT_DIR).toBe('./data/reports');
        expect(config.OPENAI_BASE_URL).toBe('https://api.openai.com/v1');
        expect(config.OPENAI_MODEL).toBe('gpt-4o-mini');
        expect(config.AGENT_SQLITE_PATH).toBe('./data/agent.sqlite');
    });

    it('自定义值覆盖默认值，PORT 强转数字', () => {
        const config = loadConfig({
            ...baseEnv,
            PORT: '8080',
            HOST: '0.0.0.0',
            NODE_ENV: 'production',
            CORS_ORIGIN: 'http://localhost:3001',
            OPENAI_BASE_URL: 'https://api.deepseek.com/v1',
            OPENAI_MODEL: 'deepseek-chat',
        });
        expect(config.PORT).toBe(8080);
        expect(config.HOST).toBe('0.0.0.0');
        expect(config.NODE_ENV).toBe('production');
        expect(config.CORS_ORIGIN).toBe('http://localhost:3001');
        expect(config.OPENAI_BASE_URL).toBe('https://api.deepseek.com/v1');
        expect(config.OPENAI_MODEL).toBe('deepseek-chat');
    });

    it.each(['abc', '0', '70000', '-1'])('非法 PORT %s 报错', (port) => {
        expect(() => loadConfig({ ...baseEnv, PORT: port })).toThrow(/PORT/);
    });

    it('非法 NODE_ENV 报错', () => {
        expect(() => loadConfig({ ...baseEnv, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
    });

    it('非法 OPENAI_BASE_URL 报错', () => {
        expect(() => loadConfig({ ...baseEnv, OPENAI_BASE_URL: 'not-a-url' })).toThrow(
            /OPENAI_BASE_URL/,
        );
    });
});

describe('THREAD_ID_PATTERN', () => {
    it.each(['a', 'abc-123_XYdef', 'a'.repeat(128)])('合法：%j', (id) => {
        expect(THREAD_ID_PATTERN.test(id)).toBe(true);
    });

    it.each(['-abc', '_abc', 'a'.repeat(129), '中文id', 'a b'])('非法：%j', (id) => {
        expect(THREAD_ID_PATTERN.test(id)).toBe(false);
    });
});
