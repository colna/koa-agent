/**
 * 会话列表 / 删除路由集成测试：真实 HTTP + 临时 SQLite checkpointer。
 * 覆盖：列表返回摘要、删除后历史 404 / 列表移除、未知会话 404、非法 id 422。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createCheckpointer } from '../agent/checkpoint.js';
import { createAgentGraph } from '../agent/graph.js';
import { createThreadStore } from '../agent/threads.js';
import { createApp } from '../app.js';
import { startServer } from '../server.js';
import { FakeChatModel } from '../testing/fake-model.js';
import { agentRouter } from './agent.js';

const dir = mkdtempSync(join(tmpdir(), 'agent-threads-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function buildApp() {
    const saver = createCheckpointer(join(dir, 'routes.sqlite'));
    const model = new FakeChatModel({ responses: ['回复甲', '回复乙'] });
    const graph = createAgentGraph({ model, systemPrompt: '', checkpointer: saver });
    const app = createApp({
        log: () => {},
        routes: [agentRouter({ graph, threads: createThreadStore(saver) })],
    });
    return { app, graph };
}

describe('GET /agent/threads + DELETE /agent/threads/:threadId', () => {
    it('列表 → 删除 → 列表移除且历史 404', async () => {
        const { app } = buildApp();
        const server = await startServer(app);
        try {
            const chat = (threadId: string, message: string) =>
                fetch(`${server.url}/agent/chat`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ threadId, message }),
                });
            await chat('t_list_a', '问题甲');
            await chat('t_list_b', '问题乙');

            const listRes = await fetch(`${server.url}/agent/threads`);
            expect(listRes.status).toBe(200);
            const list = (await listRes.json()) as {
                threads: { threadId: string; preview: string; messageCount: number }[];
            };
            // 后发起的会话排前
            expect(list.threads.map((t) => t.threadId)).toEqual(['t_list_b', 't_list_a']);
            expect(list.threads[0]).toMatchObject({ preview: '问题乙', messageCount: 2 });

            const del = await fetch(`${server.url}/agent/threads/t_list_a`, { method: 'DELETE' });
            expect(del.status).toBe(200);
            expect(await del.json()).toEqual({ threadId: 't_list_a', deleted: true });

            const after = (await (await fetch(`${server.url}/agent/threads`)).json()) as {
                threads: { threadId: string }[];
            };
            expect(after.threads.map((t) => t.threadId)).toEqual(['t_list_b']);

            const history = await fetch(`${server.url}/agent/threads/t_list_a`);
            expect(history.status).toBe(404);
        } finally {
            await server.close();
        }
    });

    it('删除未知会话 → 404；非法 threadId → 422', async () => {
        const { app } = buildApp();
        const server = await startServer(app);
        try {
            const notFound = await fetch(`${server.url}/agent/threads/t_nope`, {
                method: 'DELETE',
            });
            expect(notFound.status).toBe(404);

            const invalid = await fetch(`${server.url}/agent/threads/-bad`, { method: 'DELETE' });
            expect(invalid.status).toBe(422);
        } finally {
            await server.close();
        }
    });

    it('未接存储（MemorySaver 场景）→ 列表为空', async () => {
        const model = new FakeChatModel({ responses: [] });
        const graph = createAgentGraph({ model, systemPrompt: '' });
        const app = createApp({ log: () => {}, routes: [agentRouter({ graph })] });
        const server = await startServer(app);
        try {
            const res = await fetch(`${server.url}/agent/threads`);
            expect(await res.json()).toEqual({ threads: [] });
        } finally {
            await server.close();
        }
    });
});
