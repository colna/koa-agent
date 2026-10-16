/**
 * 会话历史接口集成测试：两轮对话后按序返回 user/assistant 消息；
 * 未知 thread → 404；非法 threadId → 422。
 */
import { AIMessage } from '@langchain/core/messages';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChartTool } from '../agent/chart-tool.js';
import { createAgentGraph } from '../agent/graph.js';
import { createApp } from '../app.js';
import { type RunningServer, startServer } from '../server.js';
import { FakeChatModel } from '../testing/fake-model.js';
import { agentRouter } from './agent.js';

const model = new FakeChatModel({ responses: ['回复一', '回复二'] });
let server: RunningServer;

beforeAll(async () => {
    const graph = createAgentGraph({ model, systemPrompt: '' });
    const app = createApp({ log: () => {}, routes: [agentRouter({ graph })] });
    server = await startServer(app);
});

afterAll(async () => {
    await server.close();
});

function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${server.url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('GET /agent/threads/:threadId', () => {
    it('返回按序的 user/assistant 消息', async () => {
        const threadId = 't_history_001';
        await post('/agent/chat', { message: '你好', threadId });
        await post('/agent/chat', { message: '再说', threadId });

        const res = await fetch(`${server.url}/agent/threads/${threadId}`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            threadId,
            messages: [
                { role: 'user', content: '你好' },
                { role: 'assistant', content: '回复一' },
                { role: 'user', content: '再说' },
                { role: 'assistant', content: '回复二' },
            ],
        });
    });

    it('未知 thread → 404 NOT_FOUND', async () => {
        const res = await fetch(`${server.url}/agent/threads/t_never_used`);
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('NOT_FOUND');
    });

    it('threadId 格式非法 → 422', async () => {
        const res = await fetch(`${server.url}/agent/threads/-abc`);
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('VALIDATION_ERROR');
    });
});

describe('历史回读：图表还原（render_chart 产出）', () => {
    it('工具轮的图表与 token 用量随该轮助手消息返回', async () => {
        const chartModel = new FakeChatModel({
            responses: [
                new AIMessage({
                    content: '',
                    tool_calls: [
                        {
                            name: 'render_chart',
                            args: {
                                kind: 'pie',
                                title: '错误码占比',
                                categories: ['ELEMENT_NOT_FOUND', 'NO_UNREAD'],
                                series: [{ name: '条数', data: [12, 3] }],
                            },
                            id: 'call_chart_history',
                            type: 'tool_call',
                        },
                    ],
                    usage_metadata: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
                }),
                new AIMessage({
                    content: '占比见上图。',
                    usage_metadata: { input_tokens: 200, output_tokens: 20, total_tokens: 220 },
                }),
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
            await fetch(`${local.url}/agent/chat`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ message: '画个占比图', threadId: 't_history_chart' }),
            });
            const res = await fetch(`${local.url}/agent/threads/t_history_chart`);
            const body = (await res.json()) as {
                messages: {
                    role: string;
                    content: string;
                    charts?: { kind: string }[];
                    usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
                }[];
            };
            const assistant = body.messages.at(-1);
            expect(assistant?.role).toBe('assistant');
            expect(assistant?.content).toBe('占比见上图。');
            expect(assistant?.charts).toHaveLength(1);
            expect(assistant?.charts?.[0]?.kind).toBe('pie');
            // 用量跨工具轮累加（110 + 220）
            expect(assistant?.usage).toEqual({
                inputTokens: 300,
                outputTokens: 30,
                totalTokens: 330,
            });
        } finally {
            await local.close();
        }
    });
});

describe('GET /agent/threads/:threadId（stream-events content-blocks 回归）', () => {
    it('助手消息 content 为块数组时仍返回正文（跳过 reasoning）；reasoning 单列字段', async () => {
        const blocksModel = new FakeChatModel({
            responses: [
                new AIMessage({
                    content: [
                        { type: 'reasoning', reasoning: '内部推理不该混入正文' },
                        { type: 'text', text: '这是正文答案' },
                    ],
                }),
            ],
        });
        const graph = createAgentGraph({ model: blocksModel, systemPrompt: '' });
        const app = createApp({ log: () => {}, routes: [agentRouter({ graph })] });
        const local = await startServer(app);
        try {
            await fetch(`${local.url}/agent/chat`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ message: '问一句', threadId: 't_history_blocks' }),
            });
            const res = await fetch(`${local.url}/agent/threads/t_history_blocks`);
            expect(await res.json()).toEqual({
                threadId: 't_history_blocks',
                messages: [
                    { role: 'user', content: '问一句' },
                    {
                        role: 'assistant',
                        content: '这是正文答案',
                        reasoning: '内部推理不该混入正文',
                    },
                ],
            });
        } finally {
            await local.close();
        }
    });
});

describe('POST /agent/threads/:threadId/rewind', () => {
    it('撤回最后一轮：历史截断且下一轮上下文不含被撤回内容', async () => {
        const rewindModel = new FakeChatModel({ responses: ['回复一', '回复二', '回复三'] });
        const graph = createAgentGraph({ model: rewindModel, systemPrompt: '' });
        const app = createApp({ log: () => {}, routes: [agentRouter({ graph })] });
        const local = await startServer(app);
        const postChat = (body: unknown) =>
            fetch(`${local.url}/agent/chat`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
        try {
            await postChat({ message: '问一', threadId: 't_rewind_001' });
            await postChat({ message: '问二', threadId: 't_rewind_001' });

            const res = await fetch(`${local.url}/agent/threads/t_rewind_001/rewind`, {
                method: 'POST',
            });
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ threadId: 't_rewind_001', removedCount: 2 });

            const history = await fetch(`${local.url}/agent/threads/t_rewind_001`);
            expect(await history.json()).toEqual({
                threadId: 't_rewind_001',
                messages: [
                    { role: 'user', content: '问一' },
                    { role: 'assistant', content: '回复一' },
                ],
            });

            // 撤回后再问：模型该轮收到的上下文不含「问二 / 回复二」
            await postChat({ message: '问三', threadId: 't_rewind_001' });
            const lastCall = rewindModel.calls.at(-1) ?? [];
            expect(lastCall.map((message) => message.text)).toEqual(['问一', '回复一', '问三']);
        } finally {
            await local.close();
        }
    });

    it('无可撤回消息（未知 thread）→ 404', async () => {
        const res = await fetch(`${server.url}/agent/threads/t_rewind_none/rewind`, {
            method: 'POST',
        });
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('NOT_FOUND');
    });

    it('threadId 格式非法 → 422', async () => {
        const res = await fetch(`${server.url}/agent/threads/-bad/rewind`, { method: 'POST' });
        expect(res.status).toBe(422);
    });
});
