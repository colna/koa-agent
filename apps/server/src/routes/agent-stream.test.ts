/**
 * SSE 流式接口集成测试：自行解析 SSE 帧，断言 delta 拼接 = done.reply。
 * 覆盖「工具回合后流式」「普通回复」「运行失败 → error 帧」三场景；
 * 底层是 stream-events 协议回调（见 src/agent/streaming.ts）。
 */
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChartTool } from '../agent/chart-tool.js';
import { createAgentGraph } from '../agent/graph.js';
import { createApp } from '../app.js';
import { type RunningServer, startServer } from '../server.js';
import { echoTool } from '../testing/echo-tool.js';
import { FakeChatModel } from '../testing/fake-model.js';
import { agentRouter } from './agent.js';

function toolCallResponse(): AIMessage {
    return new AIMessage({
        content: '',
        tool_calls: [{ name: 'echo', args: { text: 'hello' }, id: 'call_1', type: 'tool_call' }],
    });
}

const model = new FakeChatModel({
    responses: [
        toolCallResponse(),
        '回显完成：echo:hello',
        toolCallResponse(),
        '回显完成：echo:hello',
        '你好世界一二三',
    ],
});
let server: RunningServer;

beforeAll(async () => {
    const graph = createAgentGraph({ model, systemPrompt: '', tools: [echoTool] });
    const app = createApp({ log: () => {}, routes: [agentRouter({ graph })] });
    server = await startServer(app);
});

afterAll(async () => {
    await server.close();
});

function postStream(body: unknown): Promise<Response> {
    return fetch(`${server.url}/agent/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

interface SseFrame {
    event: string;
    data: string;
}

function parseSse(text: string): SseFrame[] {
    return text
        .split('\n\n')
        .filter((block) => block.trim().length > 0 && !block.startsWith(':'))
        .map((block) => {
            const lines = block.split('\n');
            return {
                event: lines.find((line) => line.startsWith('event: '))?.slice(7) ?? '',
                data: lines.find((line) => line.startsWith('data: '))?.slice(6) ?? '',
            };
        });
}

describe('POST /agent/chat/stream', () => {
    it('工具回合后逐 token 输出并以 message.done 收尾', async () => {
        const res = await postStream({ message: '帮我回显 hello', threadId: 't_stream_tool' });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');

        const frames = parseSse(await res.text());
        expect(frames.some((frame) => frame.event === 'error')).toBe(false);

        const deltas = frames
            .filter((frame) => frame.event === 'message.delta')
            .map((frame) => (JSON.parse(frame.data) as { text: string }).text);
        expect(deltas.length).toBeGreaterThan(1);
        expect(deltas.join('')).toBe('回显完成：echo:hello');

        const done = frames.find((frame) => frame.event === 'message.done');
        expect(done).toBeDefined();
        expect(JSON.parse((done as SseFrame).data)).toEqual({
            threadId: 't_stream_tool',
            reply: '回显完成：echo:hello',
        });

        const toolMessages = model.calls.at(-1) ?? [];
        expect(
            toolMessages.some(
                (message) => message instanceof ToolMessage && message.content === 'echo:hello',
            ),
        ).toBe(true);
    });

    it('工具执行发 tool.start / tool.end 帧（含工具名与结果）', async () => {
        const res = await postStream({
            message: '帮我回显 hello2',
            threadId: 't_stream_toolframe',
        });
        const frames = parseSse(await res.text());

        const start = frames.find((frame) => frame.event === 'tool.start');
        expect(start).toBeDefined();
        const startData = JSON.parse((start as SseFrame).data) as {
            calls: { name: string; args: string }[];
        };
        expect(startData.calls[0]?.name).toBe('echo');

        const end = frames.find((frame) => frame.event === 'tool.end');
        expect(end).toBeDefined();
        const endData = JSON.parse((end as SseFrame).data) as {
            results: { name: string; result: string }[];
        };
        expect(endData.results[0]).toMatchObject({ name: 'echo', result: 'echo:hello' });

        // 帧序：tool.start 在 delta 之前、tool.end 在 done 之前
        const order = frames.map((frame) => frame.event);
        expect(order.indexOf('tool.start')).toBeLessThan(order.indexOf('message.delta'));
        expect(order.indexOf('tool.end')).toBeLessThan(order.indexOf('message.done'));
    });

    it('普通回复流式输出，done.reply 与 delta 拼接一致', async () => {
        const res = await postStream({ message: '说点长的', threadId: 't_stream_plain' });
        const frames = parseSse(await res.text());

        const deltas = frames
            .filter((frame) => frame.event === 'message.delta')
            .map((frame) => (JSON.parse(frame.data) as { text: string }).text);
        const done = frames.find((frame) => frame.event === 'message.done');

        expect(deltas.join('')).toBe('你好世界一二三');
        expect(JSON.parse((done as SseFrame).data)).toEqual({
            threadId: 't_stream_plain',
            reply: '你好世界一二三',
        });
    });

    it('运行失败 → error 帧且无 done 帧', async () => {
        const res = await postStream({ message: '这次会失败' });
        const frames = parseSse(await res.text());

        const error = frames.find((frame) => frame.event === 'error');
        expect(error).toBeDefined();
        const data = JSON.parse((error as SseFrame).data) as { code: string; message: string };
        expect(data.code).toBe('AGENT_ERROR');
        expect(data.message).not.toContain('用尽');
        expect(frames.some((frame) => frame.event === 'message.done')).toBe(false);
    });

    it('render_chart 工具产出 → chart 帧带完整规格', async () => {
        // 自包含图谱（该用例需要独立脚本队列）
        const chartModel = new FakeChatModel({
            responses: [
                new AIMessage({
                    content: '',
                    tool_calls: [
                        {
                            name: 'render_chart',
                            args: {
                                kind: 'bar',
                                title: '每周错误对比',
                                categories: ['w1', 'w2'],
                                series: [{ name: '错误数', data: [12, 7] }],
                            },
                            id: 'call_chart',
                            type: 'tool_call',
                        },
                    ],
                }),
                '图表已生成，见上方。',
            ],
        });
        const graph = createAgentGraph({
            model: chartModel,
            systemPrompt: '',
            tools: [createChartTool()],
        });
        const app = createApp({ log: () => {}, routes: [agentRouter({ graph })] });
        const local = await startServer(app);
        try {
            const res = await fetch(`${local.url}/agent/chat/stream`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ message: '画个图', threadId: 't_chart_frame' }),
            });
            const frames = parseSse(await res.text());

            const chart = frames.find((frame) => frame.event === 'chart');
            expect(chart).toBeDefined();
            const data = JSON.parse((chart as SseFrame).data) as {
                spec: { kind: string; title: string; categories: string[] };
            };
            expect(data.spec.kind).toBe('bar');
            expect(data.spec.title).toBe('每周错误对比');
            expect(data.spec.categories).toEqual(['w1', 'w2']);

            const done = frames.find((frame) => frame.event === 'message.done');
            expect(done).toBeDefined();
        } finally {
            await local.close();
        }
    });

    it('模型返回 usage → 追加 usage 帧（token 消耗展示）', async () => {
        const usageModel = new FakeChatModel({
            responses: [
                new AIMessage({
                    content: '答案',
                    usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
                }),
            ],
        });
        const graph = createAgentGraph({ model: usageModel, systemPrompt: '' });
        const app = createApp({ log: () => {}, routes: [agentRouter({ graph })] });
        const local = await startServer(app);
        try {
            const res = await fetch(`${local.url}/agent/chat/stream`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ message: '说句话', threadId: 't_usage_frame' }),
            });
            const frames = parseSse(await res.text());

            const usage = frames.find((frame) => frame.event === 'usage');
            expect(usage).toBeDefined();
            expect(JSON.parse((usage as SseFrame).data)).toEqual({
                inputTokens: 100,
                outputTokens: 20,
                totalTokens: 120,
            });
            // 帧序：usage 在 done 之前
            const order = frames.map((frame) => frame.event);
            expect(order.indexOf('usage')).toBeLessThan(order.indexOf('message.done'));
        } finally {
            await local.close();
        }
    });
});
