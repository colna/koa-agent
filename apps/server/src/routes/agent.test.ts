/**
 * POST /agent/chat 集成测试（真实 HTTP + FakeChatModel）：
 * 自动/自定义 threadId、多轮上下文、422（缺字段 / 非法 threadId / 未知字段）、
 * 502 AGENT_ERROR。注意：脚本响应按用例执行顺序消费，新增用例留意队列顺序。
 */
import { AIMessage } from '@langchain/core/messages';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentGraph } from '../agent/graph.js';
import { createApp } from '../app.js';
import { type RunningServer, startServer } from '../server.js';
import { echoTool } from '../testing/echo-tool.js';
import { FakeChatModel } from '../testing/fake-model.js';
import { agentRouter } from './agent.js';

const model = new FakeChatModel({
    responses: ['自动线程回复', '第一轮回复', '第二轮带上文'],
});
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

describe('POST /agent/chat', () => {
    it('不传 threadId 自动生成并返回回复', async () => {
        const res = await post('/agent/chat', { message: '你好' });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { threadId: string; reply: string };
        expect(body.reply).toBe('自动线程回复');
        expect(body.threadId).toMatch(/^t_[0-9a-f]{16}$/);
    });

    it('同 threadId 两轮携带上下文', async () => {
        const threadId = 't_multi_turn_001';

        const first = await post('/agent/chat', { message: '你好', threadId });
        expect(first.status).toBe(200);
        expect(((await first.json()) as { reply: string }).reply).toBe('第一轮回复');

        const second = await post('/agent/chat', { message: '继续', threadId });
        expect(second.status).toBe(200);
        const secondBody = (await second.json()) as { threadId: string; reply: string };
        expect(secondBody.threadId).toBe(threadId);
        expect(secondBody.reply).toBe('第二轮带上文');

        const secondCallMessages = model.calls.at(-1) ?? [];
        expect(secondCallMessages.map((message) => message.content)).toEqual([
            '你好',
            '第一轮回复',
            '继续',
        ]);
    });

    it('缺少 message → 422 带 details', async () => {
        const res = await post('/agent/chat', {});
        expect(res.status).toBe(422);
        const body = (await res.json()) as {
            error: { code: string; details: { path: string }[] };
        };
        expect(body.error.code).toBe('VALIDATION_ERROR');
        expect(body.error.details.some((issue) => issue.path === 'message')).toBe(true);
    });

    it('threadId 格式非法 → 422 带 details', async () => {
        const res = await post('/agent/chat', { message: 'hi', threadId: 'bad id!!' });
        expect(res.status).toBe(422);
        const body = (await res.json()) as {
            error: { code: string; details: { path: string }[] };
        };
        expect(body.error.details.some((issue) => issue.path === 'threadId')).toBe(true);
    });

    it('未知字段（strict）→ 422', async () => {
        const res = await post('/agent/chat', { message: 'hi', extra: 1 });
        expect(res.status).toBe(422);
    });

    it('agent 运行失败 → 502 AGENT_ERROR', async () => {
        const res = await post('/agent/chat', { message: '这次会失败' });
        expect(res.status).toBe(502);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe('AGENT_ERROR');
        expect(body.error.message).not.toContain('用尽');
    });
});

describe('POST /agent/chat（token 用量）', () => {
    it('模型返回 usage → 响应带本轮 usage（工具轮累加）', async () => {
        const usageModel = new FakeChatModel({
            responses: [
                new AIMessage({
                    content: '',
                    tool_calls: [
                        { name: 'echo', args: { text: 'x' }, id: 'c_usage', type: 'tool_call' },
                    ],
                    usage_metadata: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
                }),
                new AIMessage({
                    content: '最终答复',
                    usage_metadata: { input_tokens: 200, output_tokens: 30, total_tokens: 230 },
                }),
            ],
        });
        const graph = createAgentGraph({
            model: usageModel,
            systemPrompt: '',
            tools: [echoTool],
        });
        const app = createApp({ log: () => {}, routes: [agentRouter({ graph })] });
        const local = await startServer(app);
        try {
            const res = await fetch(`${local.url}/agent/chat`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ message: '带工具的一轮', threadId: 't_usage_sync' }),
            });
            const body = (await res.json()) as {
                reply: string;
                usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
            };
            expect(body.reply).toBe('最终答复');
            expect(body.usage).toEqual({ inputTokens: 300, outputTokens: 40, totalTokens: 340 });
        } finally {
            await local.close();
        }
    });
});
