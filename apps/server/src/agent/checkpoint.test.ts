/**
 * checkpointer 测试：':memory:' 退化为 MemorySaver；SQLite 文件目录自动创建；
 * 核心断言 —— 「新图实例」能续读同一 thread 的历史（持久化的意义所在）。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { afterAll, describe, expect, it } from 'vitest';
import { FakeChatModel } from '../testing/fake-model.js';
import { createCheckpointer } from './checkpoint.js';
import { createAgentGraph } from './graph.js';

const dir = mkdtempSync(join(tmpdir(), 'social-proxy-agent-test-'));
const dbPath = join(dir, 'nested', 'agent.sqlite');

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('createCheckpointer', () => {
    it(':memory: 返回内存 saver', () => {
        expect(createCheckpointer(':memory:')).toBeInstanceOf(MemorySaver);
    });

    it('SQLite 文件：目录自动创建，新图实例可续读同 thread 历史', async () => {
        const model1 = new FakeChatModel({ responses: ['第一次回复'] });
        const graph1 = createAgentGraph({
            model: model1,
            checkpointer: createCheckpointer(dbPath),
            systemPrompt: '',
        });
        await graph1.invoke(
            { messages: [{ role: 'user', content: '第一句' }] },
            { configurable: { thread_id: 't_persist' } },
        );
        expect(existsSync(dbPath)).toBe(true);

        const model2 = new FakeChatModel({ responses: ['第二次回复'] });
        const graph2 = createAgentGraph({
            model: model2,
            checkpointer: createCheckpointer(dbPath),
            systemPrompt: '',
        });

        const state = await graph2.getState({ configurable: { thread_id: 't_persist' } });
        expect(state.values.messages.map((message: BaseMessage) => message.content)).toEqual([
            '第一句',
            '第一次回复',
        ]);

        await graph2.invoke(
            { messages: [{ role: 'user', content: '第二句' }] },
            { configurable: { thread_id: 't_persist' } },
        );
        const secondCallMessages = model2.calls.at(-1) ?? [];
        expect(secondCallMessages.map((message) => message.content)).toEqual([
            '第一句',
            '第一次回复',
            '第二句',
        ]);
    });
});
