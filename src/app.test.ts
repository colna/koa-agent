import Router from '@koa/router';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { type RunningServer, startServer } from './server.js';

const logs: Record<string, unknown>[] = [];
let server: RunningServer;

beforeAll(async () => {
    const testRouter = new Router();
    testRouter.post('/echo', (ctx) => {
        ctx.body = { got: ctx.request.body };
    });
    testRouter.get('/boom', () => {
        throw new Error('boom');
    });

    const app = createApp({
        log: (line) => logs.push(line),
        routes: [testRouter],
    });
    server = await startServer(app);
});

afterAll(async () => {
    await server.close();
});

describe('GET /health', () => {
    it('返回 ok、uptime 与版本号', async () => {
        const res = await fetch(`${server.url}/health`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { status: string; uptime: number; version: string };
        expect(body.status).toBe('ok');
        expect(typeof body.uptime).toBe('number');
        expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    });
});

describe('错误信封', () => {
    it('未知路由 → 404 NOT_FOUND', async () => {
        const res = await fetch(`${server.url}/nope`);
        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
    });

    it('方法不匹配 → 405 METHOD_NOT_ALLOWED', async () => {
        const res = await fetch(`${server.url}/health`, { method: 'POST' });
        expect(res.status).toBe(405);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('METHOD_NOT_ALLOWED');
    });

    it('坏 JSON 请求体 → 422 VALIDATION_ERROR', async () => {
        const res = await fetch(`${server.url}/echo`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{oops',
        });
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    it('未处理异常 → 500 INTERNAL 且不泄漏细节', async () => {
        const res = await fetch(`${server.url}/boom`);
        expect(res.status).toBe(500);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe('INTERNAL');
        expect(body.error.message).not.toContain('boom');
        expect(logs.some((line) => line.level === 'error')).toBe(true);
        expect(logs.some((line) => line.path === '/boom' && line.status === 500)).toBe(true);
    });

    it('合法 JSON 正常回显', async () => {
        const res = await fetch(`${server.url}/echo`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ hello: 'world' }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ got: { hello: 'world' } });
    });
});

describe('请求日志', () => {
    it('记录方法 / 路径 / 状态 / 耗时', async () => {
        await fetch(`${server.url}/health`);
        const line = logs.find((entry) => entry.path === '/health' && entry.status === 200);
        expect(line).toBeDefined();
        expect(line?.method).toBe('GET');
        expect(typeof line?.durationMs).toBe('number');
    });
});
