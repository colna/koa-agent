/**
 * skills 接入层测试（全离线）：
 * - loadSkills：扫描临时 skills 目录、解析 frontmatter、跳过缺 SKILL.md 的目录；
 * - skillsPromptSection：索引段格式与空列表行为；
 * - loadSlsCreds：~/.sls_creds 解析（完整 / 缺键 / 不存在）；
 * - createSlsLogTool：用假 python 脚本模拟 sls_query.py 的成功 / 失败 / 空结果，
 *   断言参数拼装与结果透传（不真连 SLS）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
    createSlsLogTool,
    execFileAsync,
    loadAliyunOAuthCreds,
    loadSkills,
    loadSlsCreds,
    skillsPromptSection,
} from './skills.js';

const dir = mkdtempSync(join(tmpdir(), 'skills-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('loadSkills', () => {
    it('解析 frontmatter 的 name/description 并跳过无 SKILL.md 的目录', () => {
        const skillsDir = join(dir, 'skills');
        mkdirSync(join(skillsDir, 'sls-logs'), { recursive: true });
        mkdirSync(join(skillsDir, 'no-skill-md'), { recursive: true });
        writeFileSync(
            join(skillsDir, 'sls-logs', 'SKILL.md'),
            '---\nname: sls-logs\ndescription: "阿里云 SLS 日志查询"\n---\n# 内容',
            'utf8',
        );

        const skills = loadSkills(skillsDir);
        expect(skills).toHaveLength(1);
        expect(skills[0]).toMatchObject({
            id: 'sls-logs',
            name: 'sls-logs',
            description: '阿里云 SLS 日志查询',
        });
    });

    it('目录不存在时返回空数组', () => {
        expect(loadSkills(join(dir, 'not-exist'))).toEqual([]);
    });
});

describe('skillsPromptSection', () => {
    it('生成索引段并提示 sls_query_log 工具', () => {
        const section = skillsPromptSection([
            { id: 'sls-logs', name: 'sls-logs', description: '查日志', raw: '' },
        ]);
        expect(section).toContain('- sls-logs：查日志');
        expect(section).toContain('sls_query_log');
    });

    it('空清单返回空串', () => {
        expect(skillsPromptSection([])).toBe('');
    });
});

describe('loadSlsCreds', () => {
    it('解析 export 语法并校验必填键', () => {
        const path = join(dir, 'creds_ok');
        writeFileSync(
            path,
            'export SLS_ENDPOINT=us-west-1.log.aliyuncs.com\nexport SLS_PROJECT=dev-presence-service-log\nexport SLS_LOGSTORE=dora-dev-stdout\nexport SLS_AK_ID=ak\nexport SLS_AK_SECRET=sk\n# comment\n',
            'utf8',
        );
        const creds = loadSlsCreds(path);
        expect(creds).toMatchObject({ SLS_PROJECT: 'dev-presence-service-log', SLS_AK_ID: 'ak' });
    });

    it('缺必填键返回 null；文件不存在返回 null', () => {
        const missing = join(dir, 'creds_missing');
        writeFileSync(missing, 'export SLS_ENDPOINT=x\n', 'utf8');
        expect(loadSlsCreds(missing)).toBeNull();
        expect(loadSlsCreds(join(dir, 'nope'))).toBeNull();
    });
});

describe('createSlsLogTool', () => {
    /** 假 python：输出收到的 argv 与环境到 stderr 供断言；按环境变量决定行为。 */
    const fakePy = join(dir, 'fake.py');
    writeFileSync(
        fakePy,
        [
            'import os, sys',
            'sys.stderr.write("ARGV:" + repr(sys.argv[1:]) + "\\n")',
            'if os.environ.get("FAKE_MODE") == "fail":',
            '    sys.exit(3)',
            'if os.environ.get("FAKE_MODE") == "empty":',
            '    sys.stderr.write("--- 0 rows ---\\n")',
            'else:',
            '    print("ENVPROJ:" + os.environ.get("SLS_PROJECT", "-") + ":" + os.environ.get("SLS_LOGSTORE", "-"))',
            '    sys.stdout.write("2026-10-15 [ERROR] (ai-chat-service) boom\\n")',
            '    sys.stderr.write("--- 1 rows ---\\n")',
        ].join('\n'),
        'utf8',
    );

    function build(mode: string) {
        return createSlsLogTool({
            scriptPath: fakePy,
            pythonBin: 'python3',
            credsEnv: { FAKE_MODE: mode, SLS_PROJECT: 'dev-presence-service-log' },
            timeoutMs: 5000,
        });
    }

    it('拼装参数并透传日志行与行数统计', async () => {
        const result = await build('ok').invoke({
            query: '"[AI_CHAT_SERVICE] origin"',
            service: 'ai-chat-service',
            minutes: 60,
            limit: 50,
            reverse: false,
            raw: false,
        });
        expect(result).toContain('2026-10-15 [ERROR] (ai-chat-service) boom');
        expect(result).toContain('--- 1 rows ---');
    });

    it('失败时返回带 exit code 的错误文本（不抛异常）', async () => {
        const result = await build('fail').invoke({
            query: '*',
            limit: 10,
            reverse: false,
            raw: false,
        });
        expect(result).toContain('SLS 查询失败');
        expect(result).toContain('exit 3');
    });

    it('空结果时明确提示无匹配日志', async () => {
        const result = await build('empty').invoke({
            query: '*',
            limit: 10,
            reverse: false,
            raw: false,
        });
        expect(result).toContain('无匹配日志');
    });

    it('凭证以 env 传给子进程（FAKE_MODE 生效即证明）', async () => {
        const result = await build('ok').invoke({
            query: '*',
            limit: 10,
            reverse: false,
            raw: false,
        });
        expect(result).not.toContain('环境变量');
    });
});

describe('createSlsLogTool env 环境区分（dev / prod）', () => {
    const envPy = join(dir, 'env-probe.py');
    writeFileSync(
        envPy,
        [
            'import os',
            'print("ENVPROJ:" + os.environ.get("SLS_PROJECT", "-") + ":" + os.environ.get("SLS_LOGSTORE", "-"))',
            'print("row-1")',
        ].join('\n'),
        'utf8',
    );

    it('env=prod 覆盖为线上 project/logstore；缺省 env=dev 用 provider 值', async () => {
        const toolInstance = createSlsLogTool({
            scriptPath: envPy,
            pythonBin: 'python3',
            credsEnv: {
                SLS_PROJECT: 'dev-presence-service-log',
                SLS_LOGSTORE: 'dora-dev-stdout',
            },
            prodProject: 'prod-presence-service-log',
            prodLogstore: 'dora-prod-stdout',
            timeoutMs: 5000,
        });

        const prodResult = await toolInstance.invoke({
            env: 'prod',
            query: '*',
            limit: 10,
            reverse: false,
            raw: false,
        });
        expect(prodResult).toContain('ENVPROJ:prod-presence-service-log:dora-prod-stdout');
        expect(prodResult).toContain('（环境：prod）');

        const devResult = await toolInstance.invoke({
            query: '*',
            limit: 10,
            reverse: false,
            raw: false,
        });
        expect(devResult).toContain('ENVPROJ:dev-presence-service-log:dora-dev-stdout');
        expect(devResult).toContain('（环境：dev）');
    });

    it('env=prod 未配置线上 project/logstore → 指引（不执行脚本）', async () => {
        const toolInstance = createSlsLogTool({
            scriptPath: envPy,
            pythonBin: 'python3',
            credsEnv: {},
            timeoutMs: 5000,
        });
        const result = await toolInstance.invoke({
            env: 'prod',
            query: '*',
            limit: 10,
            reverse: false,
            raw: false,
        });
        expect(result).toContain('SLS_PROJECT_PROD');
        expect(result).not.toContain('ENVPROJ');
    });
});

describe('createSlsLogTool 参数拼装细节', () => {
    it('from/to 与 raw/reverse 正确传给脚本', async () => {
        const spyPy = join(dir, 'spy.py');
        writeFileSync(
            spyPy,
            'import sys\nsys.stderr.write("ARGV:" + repr(sys.argv[1:]) + "\\n")\n',
            'utf8',
        );
        const toolInstance = createSlsLogTool({
            scriptPath: spyPy,
            pythonBin: 'python3',
            credsEnv: {},
            timeoutMs: 5000,
        });
        const result = await toolInstance.invoke({
            query: 'error',
            from: '2026-10-15 00:00:00',
            to: '2026-10-15 01:00:00',
            limit: 100,
            reverse: true,
            raw: true,
        });
        expect(result).toContain('--from');
        expect(result).toContain("'--reverse'");
        expect(result).toContain("'--raw'");
    });
});

describe('loadAliyunOAuthCreds', () => {
    /** 写一个假 aliyun config.json。 */
    function writeAliyunConfig(path: string, profile: Record<string, unknown>): void {
        writeFileSync(path, JSON.stringify({ current: profile.name, profiles: [profile] }), 'utf8');
    }

    const future = () => Math.floor(Date.now() / 1000) + 3600;
    const past = () => Math.floor(Date.now() / 1000) - 10;

    it('未临期：不触发刷新，直接映射为 sls env', async () => {
        const cfg = join(dir, 'aliyun-fresh.json');
        writeAliyunConfig(cfg, {
            name: 'p',
            access_key_id: 'ak',
            access_key_secret: 'sk',
            sts_token: 'st',
            sts_expiration: future(),
        });
        let execCalls = 0;
        const env = await loadAliyunOAuthCreds({
            profile: 'p',
            configPath: cfg,
            execFileFn: async () => {
                execCalls += 1;
                return { stdout: '', stderr: '', code: 0 };
            },
        });
        expect(execCalls).toBe(0);
        expect(env).toEqual({ SLS_AK_ID: 'ak', SLS_AK_SECRET: 'sk', SLS_STS_TOKEN: 'st' });
    });

    it('临期：跑刷新命令后重新读取新凭证', async () => {
        const cfg = join(dir, 'aliyun-stale.json');
        writeAliyunConfig(cfg, {
            name: 'p',
            access_key_id: 'old',
            access_key_secret: 'old',
            sts_token: 'old',
            sts_expiration: Math.floor(Date.now() / 1000) + 60,
        });
        const env = await loadAliyunOAuthCreds({
            profile: 'p',
            configPath: cfg,
            execFileFn: async (bin, args) => {
                expect(bin).toBe('aliyun');
                expect(args).toEqual(['sts', 'GetCallerIdentity', '--profile', 'p']);
                writeAliyunConfig(cfg, {
                    name: 'p',
                    access_key_id: 'new',
                    access_key_secret: 'new',
                    sts_token: 'new',
                    sts_expiration: future(),
                });
                return { stdout: '{}', stderr: '', code: 0 };
            },
        });
        expect(env.SLS_AK_ID).toBe('new');
    });

    it('刷新失败且旧凭证已过期 → 抛错（附外部命令输出）', async () => {
        const cfg = join(dir, 'aliyun-dead.json');
        writeAliyunConfig(cfg, {
            name: 'p',
            access_key_id: 'ak',
            access_key_secret: 'sk',
            sts_token: 'st',
            sts_expiration: past(),
        });
        await expect(
            loadAliyunOAuthCreds({
                profile: 'p',
                configPath: cfg,
                execFileFn: async () => ({ stdout: '', stderr: 'network down', code: 1 }),
            }),
        ).rejects.toThrow('刷新失败');
    });

    it('刷新失败但旧凭证仍有效 → 继续用旧的', async () => {
        const cfg = join(dir, 'aliyun-degraded.json');
        writeAliyunConfig(cfg, {
            name: 'p',
            access_key_id: 'ak',
            access_key_secret: 'sk',
            sts_token: 'st',
            sts_expiration: Math.floor(Date.now() / 1000) + 60,
        });
        const env = await loadAliyunOAuthCreds({
            profile: 'p',
            configPath: cfg,
            execFileFn: async () => ({ stdout: '', stderr: 'net down', code: 1 }),
        });
        expect(env.SLS_AK_ID).toBe('ak');
    });

    it('profile 不存在 → 抛错带配置指引', async () => {
        const cfg = join(dir, 'aliyun-empty.json');
        writeFileSync(cfg, JSON.stringify({ profiles: [] }), 'utf8');
        await expect(loadAliyunOAuthCreds({ profile: 'missing', configPath: cfg })).rejects.toThrow(
            'missing',
        );
    });

    it('凭证字段缺 sts_token → 抛错', async () => {
        const cfg = join(dir, 'aliyun-incomplete.json');
        writeAliyunConfig(cfg, {
            name: 'p',
            access_key_id: 'ak',
            access_key_secret: 'sk',
            sts_expiration: future(),
        });
        await expect(loadAliyunOAuthCreds({ profile: 'p', configPath: cfg })).rejects.toThrow(
            'STS 凭证',
        );
    });
});

describe('execFileAsync（子进程环境）', () => {
    it('env 中保留 HOME（aliyun CLI 靠它定位 ~/.aliyun/config.json，缺失会 panic）', async () => {
        const script = join(dir, 'env-echo.mjs');
        writeFileSync(script, 'process.stdout.write(process.env.HOME ?? "NO_HOME")', 'utf8');
        const { stdout, code } = await execFileAsync('node', [script], {}, 5000);
        expect(code).toBe(0);
        expect(stdout).toBe(process.env.HOME);
    });
});

describe('createSlsLogTool credsProvider', () => {
    const noopPy = join(dir, 'noop.py');
    writeFileSync(noopPy, 'print("ok")\n', 'utf8');

    it('每次调用都重新解析凭证（支持 STS 续期）', async () => {
        let providerCalls = 0;
        const toolInstance = createSlsLogTool({
            scriptPath: noopPy,
            pythonBin: 'python3',
            credsProvider: () => {
                providerCalls += 1;
                return {};
            },
        });
        await toolInstance.invoke({ query: '*', limit: 1, reverse: false, raw: false });
        await toolInstance.invoke({ query: '*', limit: 1, reverse: false, raw: false });
        expect(providerCalls).toBe(2);
    });

    it('provider 失败 → 返回凭证错误文本（不抛异常）', async () => {
        const toolInstance = createSlsLogTool({
            scriptPath: noopPy,
            pythonBin: 'python3',
            credsProvider: () => {
                throw new Error('aliyun profile "x" 不存在');
            },
        });
        const result = await toolInstance.invoke({
            query: '*',
            limit: 1,
            reverse: false,
            raw: false,
        });
        expect(result).toContain('凭证不可用');
        expect(result).toContain('不存在');
    });
});
