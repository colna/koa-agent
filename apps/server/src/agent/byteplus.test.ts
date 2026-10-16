/**
 * BytePlus 工具测试（全离线）：
 * - 假 node 脚本替代真实 CLI：把收到的 argv 与关键 env 原样打印，便于断言；
 * - 覆盖：命令+参数传递、凭证（直接传 / dotenv 文件解析 / 缺失指引）、
 *   失败路径（非零退出）、输出截断。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createByteplusTool, parseDotenv, resolveByteplusEnv } from './byteplus.js';

const dir = mkdtempSync(join(tmpdir(), 'byteplus-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** 假 CLI：打印 argv + env 状态；FAKE_MODE=fail 时以 3 退出；FAKE_MODE=long 时打印超长输出。 */
const fakeScript = join(dir, 'fake-byteplus.mjs');
writeFileSync(
    fakeScript,
    [
        'const mode = process.env.FAKE_MODE ?? "ok";',
        'if (mode === "fail") { process.stderr.write("boom from byteplus"); process.exit(3); }',
        'if (mode === "long") { process.stdout.write("x".repeat(1000)); process.exit(0); }',
        'process.stdout.write(JSON.stringify({',
        '  argv: process.argv.slice(2),',
        '  hasAk: Boolean(process.env.BYTEPLUS_ACCESS_KEY),',
        '  hasSk: Boolean(process.env.BYTEPLUS_SECRET_KEY),',
        '  base: process.env.BYTEPLUS_BASE_URL ?? null,',
        '}));',
    ].join('\n'),
    'utf8',
);

function buildTool(overrides: Record<string, unknown> = {}) {
    return createByteplusTool({
        scriptPath: fakeScript,
        nodeBin: 'node',
        accessKey: 'ak_test',
        secretKey: 'sk_test',
        ...overrides,
    });
}

describe('resolveByteplusEnv / parseDotenv', () => {
    it('dotenv 解析：注释 / export 前缀 / 引号 / 空行', () => {
        const parsed = parseDotenv(
            [
                '# comment',
                'BYTEPLUS_ACCESS_KEY="ak1"',
                "export BYTEPLUS_SECRET_KEY='sk1'",
                '',
                'BYTEPLUS_BASE_URL=https://x.com',
            ].join('\n'),
        );
        expect(parsed).toMatchObject({
            BYTEPLUS_ACCESS_KEY: 'ak1',
            BYTEPLUS_SECRET_KEY: 'sk1',
            BYTEPLUS_BASE_URL: 'https://x.com',
        });
    });

    it('直接凭证优先于 dotenv；缺 SK 返回 null；无凭证返回 null', () => {
        const envFile = join(dir, 'creds.env');
        writeFileSync(
            envFile,
            'BYTEPLUS_ACCESS_KEY=file_ak\nBYTEPLUS_SECRET_KEY=file_sk\n',
            'utf8',
        );

        const direct = resolveByteplusEnv({
            accessKey: 'direct_ak',
            secretKey: 'direct_sk',
            baseUrl: '',
            envFile,
        });
        expect(direct?.BYTEPLUS_ACCESS_KEY).toBe('direct_ak');

        const fromFile = resolveByteplusEnv({
            accessKey: '',
            secretKey: '',
            baseUrl: '',
            envFile,
        });
        expect(fromFile).toMatchObject({
            BYTEPLUS_ACCESS_KEY: 'file_ak',
            BYTEPLUS_SECRET_KEY: 'file_sk',
        });

        const missingSk = resolveByteplusEnv({
            accessKey: 'ak_only',
            secretKey: '',
            baseUrl: '',
            envFile: '',
        });
        expect(missingSk).toBeNull();

        const nothing = resolveByteplusEnv({
            accessKey: '',
            secretKey: '',
            baseUrl: '',
            envFile: join(dir, 'nope.env'),
        });
        expect(nothing).toBeNull();
    });
});

describe('createByteplusTool', () => {
    it('命令与参数原样传给脚本；凭证进入子进程 env', async () => {
        const result = await buildTool().invoke({
            command: 'user-call-summary',
            args: ['653834', '7333418', 'user_unique_id'],
        });
        const parsed = JSON.parse(result) as {
            argv: string[];
            hasAk: boolean;
            hasSk: boolean;
            base: string | null;
        };
        expect(parsed.argv).toEqual(['user-call-summary', '653834', '7333418', 'user_unique_id']);
        expect(parsed.hasAk).toBe(true);
        expect(parsed.hasSk).toBe(true);
        expect(parsed.base).toBeNull();
    });

    it('dotenv 文件凭证可被使用（不泄漏其它键）', async () => {
        const envFile = join(dir, 'tool-creds.env');
        writeFileSync(
            envFile,
            'BYTEPLUS_ACCESS_KEY=file_ak\nBYTEPLUS_SECRET_KEY=file_sk\nBYTEPLUS_BASE_URL=https://base.example.com\n',
            'utf8',
        );
        const result = await buildTool({
            accessKey: '',
            secretKey: '',
            envFile,
        }).invoke({ command: 'apps', args: ['pwa'] });
        const parsed = JSON.parse(result) as { hasAk: boolean; base: string | null };
        expect(parsed.hasAk).toBe(true);
        expect(parsed.base).toBe('https://base.example.com');
    });

    it('凭证缺失 → 返回配置指引（不抛异常）', async () => {
        const result = await buildTool({ accessKey: '', secretKey: '', envFile: '' }).invoke({
            command: 'apps',
            args: [],
        });
        expect(result).toContain('凭证未配置');
        expect(result).toContain('BYTEPLUS_ENV_FILE');
    });

    it('脚本失败 → 返回带 exit code 的错误文本（不抛异常）', async () => {
        const result = await buildTool({
            // FAKE_MODE 经 direct env 无法注入——用 dotenv 注入（resolveByteplusEnv 会带上文件里所有键）
            accessKey: '',
            secretKey: '',
            envFile: (() => {
                const failEnv = join(dir, 'fail.env');
                writeFileSync(
                    failEnv,
                    'BYTEPLUS_ACCESS_KEY=ak\nBYTEPLUS_SECRET_KEY=sk\nFAKE_MODE=fail\n',
                    'utf8',
                );
                return failEnv;
            })(),
        }).invoke({ command: 'apps', args: [] });
        expect(result).toContain('BytePlus 查询失败');
        expect(result).toContain('exit 3');
        expect(result).toContain('boom from byteplus');
    });

    it('输出超限截断并附提示', async () => {
        const longEnv = join(dir, 'long.env');
        writeFileSync(
            longEnv,
            'BYTEPLUS_ACCESS_KEY=ak\nBYTEPLUS_SECRET_KEY=sk\nFAKE_MODE=long\n',
            'utf8',
        );
        const result = await buildTool({
            accessKey: '',
            secretKey: '',
            envFile: longEnv,
            maxOutputChars: 100,
        }).invoke({ command: 'apps', args: [] });
        expect(result).toContain('已截断');
        expect(result.length).toBeLessThan(200);
    });
});
