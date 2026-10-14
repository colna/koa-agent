/**
 * 会话历史接口集成测试：两轮对话后按序返回 user/assistant 消息；
 * 未知 thread → 404；非法 threadId → 422。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
