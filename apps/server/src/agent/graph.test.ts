/**
 * Agent 图测试（FakeChatModel 脚本驱动，全离线）：
 * 「工具调用回合 → 最终回复」「同 thread 多轮携带上下文」「不同 thread 隔离」
 * 「系统提示词注入且不持久化」。
 * 工具用测试夹具 echo（见 ../testing/echo-tool.ts）驱动，不依赖任何业务工具。
 */
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { echoTool } from '../testing/echo-tool.js';
import { FakeChatModel } from '../testing/fake-model.js';
import { createAgentGraph, lastAiReply, newThreadId, trimHistory } from './graph.js';

function toolCallResponse(): AIMessage {
    return new AIMessage({
        content: '',
        tool_calls: [{ name: 'echo', args: { text: 'hello' }, id: 'call_1', type: 'tool_call' }],
    });
}

describe('createAgentGraph', () => {
    it('驱动一次工具调用后给出最终回复', async () => {
        const model = new FakeChatModel({
            responses: [toolCallResponse(), '回显结果是 echo:hello'],
        });
        const graph = createAgentGraph({ model, systemPrompt: '', tools: [echoTool] });

        const result = await graph.invoke(
            { messages: [{ role: 'user', content: '帮我回显 hello' }] },
            { configurable: { thread_id: 't_test1' } },
        );

        expect(lastAiReply(result.messages)).toBe('回显结果是 echo:hello');
        expect(model.calls).toHaveLength(2);

        const secondMessages = model.calls[1] ?? [];
        expect(secondMessages.map((message) => message.getType())).toEqual(['human', 'ai', 'tool']);
        const toolMessage = secondMessages.find((message) => message instanceof ToolMessage);
        expect(toolMessage?.content).toBe('echo:hello');
        expect((toolMessage as ToolMessage).tool_call_id).toBe('call_1');

        expect(model.boundTools.map((tool) => (tool as { name?: string }).name)).toEqual(['echo']);
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

    it('lastAiReply 兼容 content-blocks 数组（流式路径回归：跳过 reasoning 取文本）', () => {
        const message = new AIMessage({
            content: [
                { type: 'reasoning', reasoning: '内部思考不该被当成回复' },
                { type: 'text', text: '这是正文回复' },
            ],
        });
        expect(lastAiReply([message])).toBe('这是正文回复');
    });
});

describe('trimHistory（上下文裁剪）', () => {
    const human = (text: string) => new HumanMessage(text);
    const ai = (text: string) => new AIMessage(text);
    const aiTool = () =>
        new AIMessage({
            content: '',
            tool_calls: [
                { name: 'echo', args: { text: 'x' }, id: `c_${Math.random()}`, type: 'tool_call' },
            ],
        });
    const tool = () => new ToolMessage({ content: '结果', tool_call_id: 'c', name: 'echo' });

    it('预算内不裁剪（原样返回）', () => {
        const messages = [human('问'), ai('答')];
        expect(trimHistory(messages, 10_000)).toEqual(messages);
    });

    it('裁剪旧轮：从 human 边界开始保留最近完整轮', () => {
        const messages = [
            human('旧'.repeat(300)),
            ai('答'.repeat(300)),
            human('新问题'),
            ai('新回答'),
        ];
        const trimmed = trimHistory(messages, 40);
        expect(trimmed.map((m) => m.text)).toEqual(['新问题', '新回答']);
    });

    it('裁切点落在工具轮中间时回整轮（保留其 human 起点）', () => {
        const messages = [
            human('旧'.repeat(300)),
            ai('答'.repeat(300)),
            human('要保留的追问'),
            aiTool(),
            tool(),
        ];
        const trimmed = trimHistory(messages, 40);
        expect(trimmed[0]?.text).toBe('要保留的追问');
        expect(trimmed).toHaveLength(3);
        expect(trimmed.at(-1)?.getType()).toBe('tool');
    });

    it('单轮超预算：整轮保留（宁可略超不破坏序列）', () => {
        const messages = [human('超长问题'.repeat(500)), ai('很长的回答'.repeat(500))];
        expect(trimHistory(messages, 1)).toEqual(messages);
    });
});

describe('createAgentGraph（上下文裁剪集成）', () => {
    it('超预算时模型只看到最近轮次；checkpointer 全量保留', async () => {
        const model = new FakeChatModel({ responses: ['回复一', '回复二', '回复三'] });
        const graph = createAgentGraph({ model, systemPrompt: '', maxInputTokens: 15 });
        const config = { configurable: { thread_id: 't_trim_integration' } };
        await graph.invoke({ messages: [{ role: 'user', content: '第一轮问题' }] }, config);
        await graph.invoke({ messages: [{ role: 'user', content: '第二轮问题' }] }, config);
        await graph.invoke({ messages: [{ role: 'user', content: '第三轮问题' }] }, config);

        const lastCall = model.calls.at(-1) ?? [];
        expect(lastCall.map((m) => m.text)).toEqual(['第三轮问题']);

        const state = await graph.getState(config);
        expect((state.values as { messages: unknown[] }).messages).toHaveLength(6);
    });
});
