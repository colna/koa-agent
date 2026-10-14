/**
 * SpAdminClient 单测：用本地 mock HTTP 服务模拟 minerva BFF 的行为（全离线）。
 * 覆盖：双层解包、外层错误、401 指引、连接失败、未配置 token、query 组装、CSV 流式落盘。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SpAdminClient, SpClientError } from './client.js';

const servers: Server[] = [];

async function startMockServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
}

afterAll(async () => {
    await Promise.all(
        servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
});

function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

describe('SpAdminClient.request', () => {
    it('双层解包：外层 success → 返回内层 data，并带 Bearer 头', async () => {
        let seenAuth = '';
        const baseUrl = await startMockServer((req, res) => {
            seenAuth = req.headers.authorization ?? '';
            json(res, 200, { success: true, data: { items: [1, 2], total: 2 } });
        });
        const client = new SpAdminClient({ baseUrl, token: 'test-token' });

        const data = await client.request<{ items: number[]; total: number }>({
            path: '/api/social-proxy/demo',
        });

        expect(data).toEqual({ items: [1, 2], total: 2 });
        expect(seenAuth).toBe('Bearer test-token');
    });

    it('外层 success=false → api 错误（携带上游 error.message）', async () => {
        const baseUrl = await startMockServer((_req, res) => {
            json(res, 400, { success: false, error: { message: '上游炸了' } });
        });
        const client = new SpAdminClient({ baseUrl, token: 't' });

        await expect(client.request({ path: '/demo' })).rejects.toMatchObject({
            name: 'SpClientError',
            kind: 'api',
        });
        await expect(client.request({ path: '/demo' })).rejects.toThrow(/上游炸了/);
    });

    it('401 → auth 错误并提示更新 SP_ADMIN_TOKEN', async () => {
        const baseUrl = await startMockServer((_req, res) => {
            json(res, 401, { message: 'unauthorized' });
        });
        const client = new SpAdminClient({ baseUrl, token: 'expired' });

        await expect(client.request({ path: '/demo' })).rejects.toThrow(/SP_ADMIN_TOKEN/);
        await expect(client.request({ path: '/demo' })).rejects.toMatchObject({ kind: 'auth' });
    });

    it('连接失败 → connection 错误（带 baseUrl 提示）', async () => {
        const client = new SpAdminClient({ baseUrl: 'http://127.0.0.1:1', token: 't' });
        await expect(client.request({ path: '/demo' })).rejects.toMatchObject({
            kind: 'connection',
        });
    });

    it('未配置 token → config 错误且不发请求', async () => {
        const client = new SpAdminClient({ baseUrl: 'http://127.0.0.1:1', token: '' });
        const error = await client.request({ path: '/demo' }).catch((err: unknown) => err);
        expect(error).toBeInstanceOf(SpClientError);
        expect((error as SpClientError).kind).toBe('config');
    });

    it('query 组装：undefined 跳过、值转字符串', async () => {
        let seenUrl = '';
        const baseUrl = await startMockServer((req, res) => {
            seenUrl = req.url ?? '';
            json(res, 200, { success: true, data: null });
        });
        const client = new SpAdminClient({ baseUrl, token: 't' });

        await client.request({
            path: '/api/social-proxy/script/error-logs',
            query: { page: 1, pageSize: 2000, action: undefined, errorCode: 'ELEMENT_NOT_FOUND' },
        });

        expect(seenUrl).toBe(
            '/api/social-proxy/script/error-logs?page=1&pageSize=2000&errorCode=ELEMENT_NOT_FOUND',
        );
    });
});

describe('SpAdminClient.downloadToFile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-client-test-'));

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('CSV 流式落盘并返回字节数', async () => {
        const content = '时间,Action\n2026-10-14,clickFollowButton\n';
        const baseUrl = await startMockServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8' });
            res.write(content.slice(0, 10));
            res.end(content.slice(10));
        });
        const client = new SpAdminClient({ baseUrl, token: 't' });
        const filePath = join(dir, 'export.csv');

        const bytes = await client.downloadToFile({ path: '/export' }, filePath);

        expect(bytes).toBe(Buffer.byteLength(content));
        expect(readFileSync(filePath, 'utf8')).toBe(content);
    });

    it('401 时抛 auth 错误（不落盘）', async () => {
        const baseUrl = await startMockServer((_req, res) => {
            json(res, 401, {});
        });
        const client = new SpAdminClient({ baseUrl, token: 't' });
        await expect(
            client.downloadToFile({ path: '/export' }, join(dir, 'no.csv')),
        ).rejects.toMatchObject({ kind: 'auth' });
    });
});
