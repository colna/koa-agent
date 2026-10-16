/**
 * streamChat 的离线集成测试：起一个本地 mock HTTP 服务模拟 server 的 SSE 行为，
 * 验证「分片到达 → 帧解析 → 回调」全链路（不依赖真实 server / 外网）。
 */

import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import {
    deleteThread,
    fetchThreads,
    rewindThread,
    type StreamChatHandlers,
    streamChat,
} from './api';

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
    const toolStarts: {
        calls: { name: string; args: string }[];
        thought?: string;
    }[] = [];
    const toolEnds: { results: { name: string; result: string }[] }[] = [];
    const reasonings: string[] = [];
    const charts: unknown[] = [];
    const usages: unknown[] = [];
    const handlers: StreamChatHandlers = {
        onDelta: (text) => deltas.push(text),
        onDone: (payload) => {
            done = payload;
        },
        onError: (payload) => {
            error = payload;
        },
        onToolStart: (payload) => toolStarts.push(payload),
        onToolEnd: (payload) => toolEnds.push(payload),
        onReasoning: (text) => reasonings.push(text),
        onChart: (spec) => charts.push(spec),
        onUsage: (usage) => usages.push(usage),
    };
    return {
        handlers,
        deltas,
        toolStarts,
        toolEnds,
        reasonings,
        charts,
        usages,
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

    it('tool.start / tool.end 帧 → 工具回调（含 thought 与结果）', async () => {
        const baseUrl = await startMockServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
            res.write(
                'event: tool.start\ndata: {"calls":[{"name":"sls_query_log","args":"{\\"minutes\\":60}"}],"thought":"我先查最近一小时日志"}\n\n',
            );
            res.write('event: message.delta\ndata: {"text":"分析如下"}\n\n');
            res.write(
                'event: tool.end\ndata: {"results":[{"name":"sls_query_log","result":"日志行1\\n日志行2"}]}\n\n',
            );
            res.write('event: message.done\ndata: {"threadId":"t_mock","reply":"分析如下"}\n\n');
            res.end();
        });

        const collected = collectingHandlers();
        await streamChat({ message: '查日志', threadId: 't_mock' }, collected.handlers, baseUrl);

        expect(collected.toolStarts).toEqual([
            {
                calls: [{ name: 'sls_query_log', args: '{"minutes":60}' }],
                thought: '我先查最近一小时日志',
            },
        ]);
        expect(collected.toolEnds).toEqual([
            { results: [{ name: 'sls_query_log', result: '日志行1\n日志行2' }] },
        ]);
        expect(collected.deltas.join('')).toBe('分析如下');
    });

    it('tool.start 缺 calls / tool.end 缺 results → 不触发回调（容错）', async () => {
        const baseUrl = await startMockServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
            res.write('event: tool.start\ndata: {"calls":[]}\n\n');
            res.write('event: tool.end\ndata: {"results":[]}\n\n');
            res.write('event: message.done\ndata: {"threadId":"t_mock","reply":"ok"}\n\n');
            res.end();
        });

        const collected = collectingHandlers();
        await streamChat({ message: 'hi', threadId: 't_mock' }, collected.handlers, baseUrl);

        expect(collected.toolStarts).toEqual([]);
        expect(collected.toolEnds).toEqual([]);
        expect(collected.done).toEqual({ threadId: 't_mock', reply: 'ok' });
    });

    it('reasoning.delta 帧 → onReasoning 回调（与 message.delta 互不混淆）', async () => {
        const baseUrl = await startMockServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
            res.write('event: reasoning.delta\ndata: {"text":"先分析"}\n\n');
            res.write('event: reasoning.delta\ndata: {"text":"再回答"}\n\n');
            res.write('event: message.delta\ndata: {"text":"答案"}\n\n');
            res.write('event: message.done\ndata: {"threadId":"t_mock","reply":"答案"}\n\n');
            res.end();
        });

        const collected = collectingHandlers();
        await streamChat({ message: 'hi', threadId: 't_mock' }, collected.handlers, baseUrl);

        expect(collected.reasonings.join('')).toBe('先分析再回答');
        expect(collected.deltas.join('')).toBe('答案');
    });

    it('chart 帧 → onChart 回调；脏规格被守卫忽略', async () => {
        const baseUrl = await startMockServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
            res.write(
                'event: chart\ndata: {"spec":{"kind":"bar","title":"对比","categories":["a","b"],"series":[{"name":"s","data":[1,2]}]}}\n\n',
            );
            res.write('event: chart\ndata: {"spec":{"kind":"unknown","title":"x"}}\n\n'); // 脏帧
            res.write('event: message.done\ndata: {"threadId":"t_mock","reply":"ok"}\n\n');
            res.end();
        });

        const collected = collectingHandlers();
        await streamChat({ message: 'hi', threadId: 't_mock' }, collected.handlers, baseUrl);

        expect(collected.charts).toHaveLength(1);
        expect(collected.charts[0]).toMatchObject({ kind: 'bar', title: '对比' });
    });

    it('usage 帧 → onUsage 回调；脏帧被守卫忽略', async () => {
        const baseUrl = await startMockServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
            res.write(
                'event: usage\ndata: {"inputTokens":100,"outputTokens":20,"totalTokens":120}\n\n',
            );
            res.write('event: usage\ndata: {"inputTokens":"x"}\n\n'); // 脏帧
            res.write('event: message.done\ndata: {"threadId":"t_mock","reply":"ok"}\n\n');
            res.end();
        });

        const collected = collectingHandlers();
        await streamChat({ message: 'hi', threadId: 't_mock' }, collected.handlers, baseUrl);

        expect(collected.usages).toEqual([
            { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        ]);
    });
});

describe('rewindThread', () => {
    it('成功（200）→ true；无可撤回（404）→ false；网络失败 → false', async () => {
        const okUrl = await startMockServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"threadId":"t_ok","removedCount":2}');
        });
        expect(await rewindThread('t_ok', okUrl)).toBe(true);

        const notFoundUrl = await startMockServer((_req, res) => {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end('{"error":{"code":"NOT_FOUND"}}');
        });
        expect(await rewindThread('t_none', notFoundUrl)).toBe(false);

        expect(await rewindThread('t_x', 'http://127.0.0.1:1')).toBe(false);
    });
});

describe('fetchThreads / deleteThread', () => {
    it('fetchThreads：解析列表；异常响应返回 null', async () => {
        const okUrl = await startMockServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
                JSON.stringify({
                    threads: [
                        {
                            threadId: 't_a',
                            preview: '问题',
                            messageCount: 2,
                            updatedAt: '2026-10-15T12:00:00.000Z',
                        },
                    ],
                }),
            );
        });
        const threads = await fetchThreads(okUrl);
        expect(threads).toEqual([
            {
                threadId: 't_a',
                preview: '问题',
                messageCount: 2,
                updatedAt: '2026-10-15T12:00:00.000Z',
            },
        ]);

        const badUrl = await startMockServer((_req, res) => {
            res.writeHead(500);
            res.end('boom');
        });
        expect(await fetchThreads(badUrl)).toBeNull();
        expect(await fetchThreads('http://127.0.0.1:1')).toBeNull();
    });

    it('deleteThread：200 → true；404 → false', async () => {
        const okUrl = await startMockServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"threadId":"t_a","deleted":true}');
        });
        expect(await deleteThread('t_a', okUrl)).toBe(true);

        const notFoundUrl = await startMockServer((_req, res) => {
            res.writeHead(404);
            res.end('{}');
        });
        expect(await deleteThread('t_none', notFoundUrl)).toBe(false);
    });
});
