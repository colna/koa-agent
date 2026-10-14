/**
 * SP 报表下载路由测试：正常下载、未知文件 404、非法文件名（路径穿越）400。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { type RunningServer, startServer } from '../server.js';
import { spRouter } from './sp.js';

const dir = mkdtempSync(join(tmpdir(), 'sp-routes-test-'));
writeFileSync(join(dir, 'script-errors_20261014_203000.csv'), 'a,b\n1,2\n');
writeFileSync(join(dir, 'keep.txt'), 'secret');

let server: RunningServer;

beforeAll(async () => {
    const app = createApp({ log: () => {}, routes: [spRouter({ reportDir: dir })] });
    server = await startServer(app);
});

afterAll(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
});

describe('GET /sp/reports/:name', () => {
    it('正常下载 CSV（内容 + Content-Disposition）', async () => {
        const res = await fetch(`${server.url}/sp/reports/script-errors_20261014_203000.csv`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/csv');
        expect(res.headers.get('content-disposition')).toContain(
            'script-errors_20261014_203000.csv',
        );
        expect(await res.text()).toBe('a,b\n1,2\n');
    });

    it('未知文件 → 404 NOT_FOUND 信封', async () => {
        const res = await fetch(`${server.url}/sp/reports/script-errors_20990101_000000.csv`);
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('NOT_FOUND');
    });

    it('非法文件名（点开头）→ 400 拒绝', async () => {
        const res = await fetch(`${server.url}/sp/reports/..x`);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('BAD_REQUEST');
    });

    it('路径穿越（编码的 ..）→ 被拒（路由层或处理器层 400/404 均可）', async () => {
        const res = await fetch(`${server.url}/sp/reports/%2e%2e`);
        expect([400, 404]).toContain(res.status);
    });

    it('非法字符文件名 → 400 拒绝', async () => {
        const res = await fetch(`${server.url}/sp/reports/%2e%2e%2fkeep.txt`);
        expect([400, 404]).toContain(res.status); // 编码斜杠可能被路由层拦为 404，均视为拒绝
    });
});
