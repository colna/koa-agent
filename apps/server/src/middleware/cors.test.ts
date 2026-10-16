/**
 * CORS 中间件测试：预检 204 + 允许头、普通响应带 ACAO、
 * 具体 origin 时回显 + Vary: Origin、预检不进路由。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { type RunningServer, startServer } from '../server.js';

let server: RunningServer;
let strictServer: RunningServer;

beforeAll(async () => {
    server = await startServer(createApp({ log: () => {} })); // 默认 origin='*'
    strictServer = await startServer(
        createApp({ log: () => {}, corsOrigin: 'http://localhost:3001' }),
    );
});

afterAll(async () => {
    await server.close();
    await strictServer.close();
});

describe('corsMiddleware', () => {
    it('OPTIONS 预检 → 204 + 允许方法/头（DELETE 必须放行：会话删除是跨域请求）', async () => {
        const res = await fetch(`${server.url}/agent/threads/t_x`, {
            method: 'OPTIONS',
            headers: {
                origin: 'http://localhost:3001',
                'access-control-request-method': 'DELETE',
                'access-control-request-headers': 'content-type',
            },
        });
        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        expect(res.headers.get('access-control-allow-methods')).toContain('POST');
        expect(res.headers.get('access-control-allow-methods')).toContain('DELETE');
        expect(res.headers.get('access-control-allow-headers')).toContain('Content-Type');
    });

    it('普通请求带 Access-Control-Allow-Origin', async () => {
        const res = await fetch(`${server.url}/health`);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('配置具体 origin 时回显该 origin 且带 Vary: Origin', async () => {
        const res = await fetch(`${strictServer.url}/health`, {
            headers: { origin: 'http://localhost:3001' },
        });
        expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3001');
        expect(res.headers.get('vary')).toContain('Origin');
    });

    it('预检不进路由：不存在的路径 OPTIONS 也是 204', async () => {
        const res = await fetch(`${server.url}/not-exist`, { method: 'OPTIONS' });
        expect(res.status).toBe(204);
    });
});
