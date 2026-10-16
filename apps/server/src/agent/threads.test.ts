/**
 * 会话存储测试（离线集成）：用临时 SQLite 真库跑两轮对话，
 * 验证列表摘要（预览/条数/排序）与删除（连同 checkpoint 清空）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySaver } from '@langchain/langgraph';
import { afterAll, describe, expect, it } from 'vitest';
import { FakeChatModel } from '../testing/fake-model.js';
import { createCheckpointer } from './checkpoint.js';
import { createAgentGraph } from './graph.js';
import { createThreadStore } from './threads.js';

const dir = mkdtempSync(join(tmpdir(), 'threads-store-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('createThreadStore（SQLite）', () => {
    it('list 返回摘要并按最后活跃倒序；remove 清空该会话', async () => {
        const saver = createCheckpointer(join(dir, 'threads.sqlite'));
        const model = new FakeChatModel({ responses: ['回复A1', '回复A2', '回复B1'] });
        const graph = createAgentGraph({ model, systemPrompt: '', checkpointer: saver });
        const store = createThreadStore(saver);

        // 会话 A 两轮；会话 B 一轮（B 更新）
        await graph.invoke(
            { messages: [{ role: 'user', content: '多行\n问题 A1' }] },
            { configurable: { thread_id: 't_store_a' } },
        );
        await graph.invoke(
            { messages: [{ role: 'user', content: '问题 A2' }] },
            { configurable: { thread_id: 't_store_a' } },
        );
        await graph.invoke(
            { messages: [{ role: 'user', content: '问题 B1' }] },
            { configurable: { thread_id: 't_store_b' } },
        );

        const threads = await store.list();
        expect(threads.map((t) => t.threadId)).toEqual(['t_store_b', 't_store_a']);
        expect(threads[0]).toMatchObject({
            threadId: 't_store_b',
            preview: '问题 B1',
            messageCount: 2,
        });
        expect(threads[1]).toMatchObject({
            threadId: 't_store_a',
            preview: '多行 问题 A1', // 换行折叠为空格
            messageCount: 4,
        });
        expect(threads[0]?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

        await store.remove('t_store_a');
        const after = await store.list();
        expect(after.map((t) => t.threadId)).toEqual(['t_store_b']);
        const stateA = await graph.getState({ configurable: { thread_id: 't_store_a' } });
        expect((stateA.values as { messages?: unknown[] }).messages ?? []).toHaveLength(0);
    });
});

describe('createThreadStore（MemorySaver）', () => {
    it('列表为空、删除抛错（内存库无法跨连接管理）', async () => {
        const store = createThreadStore(new MemorySaver());
        expect(await store.list()).toEqual([]);
        await expect(store.remove('t_x')).rejects.toThrow('不支持删除');
    });
});
