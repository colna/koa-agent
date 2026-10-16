/**
 * 知识库工具测试（全离线）：假 `colna` CLI（node 脚本 + 可执行权限）模拟混合检索；
 * 覆盖：检索透传（含 ANSI 剥离）、未配置指引、笔记读取、路径穿越拒绝、缺失文件。
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createKbTools } from './kb-tools.js';

const dir = mkdtempSync(join(tmpdir(), 'kb-tools-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// 假 colna CLI：search 打印带 ANSI 色的结果（含传入的关键词）
const fakeCli = join(dir, 'colna');
writeFileSync(
    fakeCli,
    [
        '#!/usr/bin/env node',
        'const [cmd, query] = process.argv.slice(2);',
        'if (cmd === "search") {',
        '  process.stdout.write("\\x1b[32m查询: " + query + "\\x1b[0m\\n");',
        '  process.stdout.write("- 命中笔记: 30-Resources/troubleshooting/x.md\\n");',
        '} else {',
        '  process.exit(2);',
        '}',
        '',
    ].join('\n'),
    'utf8',
);
chmodSync(fakeCli, 0o755);

// memory/ 下的假笔记
mkdirSync(join(dir, 'memory', '30-Resources', 'troubleshooting'), { recursive: true });
writeFileSync(
    join(dir, 'memory', '30-Resources', 'troubleshooting', 'x.md'),
    '# 排错笔记\n内容正文',
    'utf8',
);

function build(memoDir: string) {
    return createKbTools({ memoDir, timeoutMs: 5000 });
}

describe('kb_search', () => {
    it('执行 CLI 并返回结果（ANSI 已剥离、关键词透传）', async () => {
        const { kbSearch } = build(dir);
        const result = await kbSearch.invoke({ query: 'CORS 预检' });
        expect(result).toContain('查询: CORS 预检');
        expect(result).toContain('30-Resources/troubleshooting/x.md');
        expect(result).not.toContain('\x1b[');
    });

    it('未配置 KB_MEMO_DIR → 返回配置指引', async () => {
        const { kbSearch } = build('');
        const result = await kbSearch.invoke({ query: 'x' });
        expect(result).toContain('KB_MEMO_DIR');
    });
});

describe('kb_read', () => {
    it('读取 memory/ 下的笔记全文', async () => {
        const { kbRead } = build(dir);
        const result = await kbRead.invoke({ path: '30-Resources/troubleshooting/x.md' });
        expect(result).toContain('# 排错笔记');
    });

    it('路径穿越（../ 与绝对路径）→ 拒绝', async () => {
        const { kbRead } = build(dir);
        expect(await kbRead.invoke({ path: '../etc/passwd' })).toContain('拒绝');
        expect(await kbRead.invoke({ path: '/etc/hosts' })).toContain('拒绝');
    });

    it('不存在的笔记 → 读取失败', async () => {
        const { kbRead } = build(dir);
        expect(await kbRead.invoke({ path: '30-Resources/nope.md' })).toContain('读取失败');
    });
});
