/**
 * Agent 图测试（FakeChatModel 脚本驱动，全离线）：
 * 「工具调用回合 → 最终回复」「同 thread 多轮携带上下文」「不同 thread 隔离」
 * 「系统提示词注入且不持久化」。
 * 也是理解 ReAct 循环实际怎么跑的最佳读物。
 */
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { FakeChatModel } from '../testing/fake-model.js';
import { createAgentGraph, lastAiReply, newThreadId } from './graph.js';

function toolCallResponse(): AIMessage {
    return new AIMessage({
        content: '',
        tool_calls: [
            { name: 'calculator', args: { expression: '1+2*3' }, id: 'call_1', type: 'tool_call' },
        ],
    });
}

describe('createAgentGraph', () => {
    it('驱动一次工具调用后给出最终回复', async () => {
        const model = new FakeChatModel({ responses: [toolCallResponse(), '1+2*3 = 7'] });
        const graph = createAgentGraph({ model, systemPrompt: '' });

        const result = await graph.invoke(
            { messages: [{ role: 'user', content: '帮我算 1+2*3' }] },
            { configurable: { thread_id: 't_test1' } },
        );

        expect(lastAiReply(result.messages)).toBe('1+2*3 = 7');
        expect(model.calls).toHaveLength(2);

        const secondMessages = model.calls[1] ?? [];
        expect(secondMessages.map((message) => message.getType())).toEqual(['human', 'ai', 'tool']);
        const toolMessage = secondMessages.find((message) => message instanceof ToolMessage);
        expect(toolMessage?.content).toBe('7');
        expect((toolMessage as ToolMessage).tool_call_id).toBe('call_1');

        expect(model.boundTools.map((tool) => (tool as { name?: string }).name)).toEqual([
            'calculator',
            'current_time',
        ]);
    });

    it('同 thread_id 两轮对话携带上下文', async () => {
        const model = new FakeChatModel({ responses: ['你好，我是助手', '你说过你好'] });
        const graph = createAgentGraph({ model, systemPrompt: '' });
        const config = { configurable: { thread_id: 't_test2' } };

        await graph.invoke({ messages: [{ role: 'user', content: '你好' }] }, config);
        const second = await graph.invoke(
            { messages: [{ role: 'user', content: '我说过什么' }] },
            config,
        );

        expect(lastAiReply(second.messages)).toBe('你说过你好');
        const secondCallMessages = model.calls[1] ?? [];
        expect(secondCallMessages.map((message) => message.content)).toEqual([
            '你好',
            '你好，我是助手',
            '我说过什么',
        ]);
    });

    it('不同 thread_id 会话隔离', async () => {
        const model = new FakeChatModel({ responses: ['a', 'b'] });
        const graph = createAgentGraph({ model, systemPrompt: '' });

        await graph.invoke(
            { messages: [{ role: 'user', content: '第一会话' }] },
            { configurable: { thread_id: 't_a' } },
        );
        await graph.invoke(
            { messages: [{ role: 'user', content: '第二会话' }] },
            { configurable: { thread_id: 't_b' } },
        );

        const secondCallMessages = model.calls[1] ?? [];
        expect(secondCallMessages).toHaveLength(1);
        expect(secondCallMessages[0]?.content).toBe('第二会话');
    });

    it('默认系统提示词注入且不进入持久历史', async () => {
        const model = new FakeChatModel({ responses: ['好的', '再答'] });
        const graph = createAgentGraph({ model });
        const config = { configurable: { thread_id: 't_sys' } };

        await graph.invoke({ messages: [{ role: 'user', content: '嗨' }] }, config);
        await graph.invoke({ messages: [{ role: 'user', content: '再来' }] }, config);

        const firstCall = model.calls[0] ?? [];
        expect(firstCall[0]?.getType()).toBe('system');

        const secondCall = model.calls[1] ?? [];
        expect(secondCall.map((message) => message.getType())).toEqual([
            'system',
            'human',
            'ai',
            'human',
        ]);
    });
});

describe('newThreadId / lastAiReply', () => {
    it('newThreadId 符合命名规则且唯一', () => {
        const first = newThreadId();
        const second = newThreadId();
        expect(first).toMatch(/^t_[0-9a-f]{16}$/);
        expect(first).not.toBe(second);
    });

    it('lastAiReply 无 AI 消息时返回空串', () => {
        expect(lastAiReply([])).toBe('');
    });
});
