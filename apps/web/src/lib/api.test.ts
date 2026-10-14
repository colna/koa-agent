/**
 * streamChat 的离线集成测试：起一个本地 mock HTTP 服务模拟 server 的 SSE 行为，
 * 验证「分片到达 → 帧解析 → 回调」全链路（不依赖真实 server / 外网）。
 */

import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { type StreamChatHandlers, streamChat } from './api';

const servers: Server[] = [];

async function startMockServer(
    handler: (
        req: import('node:http').IncomingMessage,
        res: import('node:http').ServerResponse,
    ) => void,
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

function collectingHandlers() {
    const deltas: string[] = [];
    let done: { threadId: string; reply: string } | null = null;
    let error: { code: string; message: string } | null = null;
    const handlers: StreamChatHandlers = {
        onDelta: (text) => deltas.push(text),
        onDone: (payload) => {
            done = payload;
        },
        onError: (payload) => {
            error = payload;
        },
    };
    return {
        handlers,
        deltas,
        get done() {
            return done;
        },
        get error() {
            return error;
        },
    };
}

describe('streamChat', () => {
    it('分片到达（含半帧拼接）→ delta 累积 + done 回调', async () => {
        const baseUrl = await startMockServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
            // 故意把一帧切两半写，验证解析缓冲
            res.write('event: message.delta\ndata: {"te');
            setTimeout(() => {
                res.write('xt":"你好"}\n\n');
                res.write('event: message.delta\ndata: {"text":"世界"}\n\n');
                res.write(
                    'event: message.done\ndata: {"threadId":"t_mock","reply":"你好世界"}\n\n',
                );
                res.end();
            }, 10);
        });

        const collected = collectingHandlers();
        await streamChat({ message: 'hi', threadId: 't_mock' }, collected.handlers, baseUrl);

        expect(collected.deltas.join('')).toBe('你好世界');
        expect(collected.done).toEqual({ threadId: 't_mock', reply: '你好世界' });
        expect(collected.error).toBeNull();
    });

    it('error 帧 → onError 回调', async () => {
        const baseUrl = await startMockServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
            res.write('event: error\ndata: {"code":"AGENT_ERROR","message":"Agent 运行失败"}\n\n');
            res.end();
        });

        const collected = collectingHandlers();
        await streamChat({ message: 'hi', threadId: 't_mock' }, collected.handlers, baseUrl);

        expect(collected.error).toEqual({ code: 'AGENT_ERROR', message: 'Agent 运行失败' });
        expect(collected.done).toBeNull();
    });

    it('非 SSE 错误响应（502 信封）→ onError 带业务码', async () => {
        const baseUrl = await startMockServer((_req, res) => {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 'AGENT_ERROR', message: 'Agent 运行失败' } }));
        });

        const collected = collectingHandlers();
        await streamChat({ message: 'hi', threadId: 't_mock' }, collected.handlers, baseUrl);

        expect(collected.error).toEqual({ code: 'AGENT_ERROR', message: 'Agent 运行失败' });
    });
});
