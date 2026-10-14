/**
 * FakeChatModel 自测：脚本消费与耗尽、bindTools 记录、流式分片聚合，
 * 以及「tool_calls 经流式聚合不丢失」这一关键性质。
 */
import { AIMessage, type AIMessageChunk, HumanMessage } from '@langchain/core/messages';
import { concat } from '@langchain/core/utils/stream';
import { describe, expect, it } from 'vitest';
import { FakeChatModel } from './fake-model.js';

describe('FakeChatModel', () => {
    it('invoke 返回脚本回复（字符串脚本）', async () => {
        const model = new FakeChatModel({ responses: ['你好世界'] });
        const reply = await model.invoke([new HumanMessage('hi')]);
        expect(reply.content).toBe('你好世界');
    });

    it('响应耗尽时抛错', async () => {
        const model = new FakeChatModel({ responses: [] });
        await expect(model.invoke([new HumanMessage('hi')])).rejects.toThrow(/用尽/);
    });

    it('bindTools 记录工具并返回自身', () => {
        const model = new FakeChatModel({ responses: ['ok'] });
        const bound = model.bindTools([{ name: 'calculator' }, { name: 'current_time' }]);
        expect(bound).toBe(model);
        expect(model.boundTools.map((tool) => (tool as { name?: string }).name)).toEqual([
            'calculator',
            'current_time',
        ]);
    });

    it('stream 逐块输出，拼接等于脚本内容', async () => {
        const model = new FakeChatModel({ responses: ['你好世界一二三'] });
        const pieces: string[] = [];
        const stream = await model.stream([new HumanMessage('hi')]);
        for await (const chunk of stream) {
            pieces.push(typeof chunk.content === 'string' ? chunk.content : '');
        }
        expect(pieces.length).toBeGreaterThan(1);
        expect(pieces.join('')).toBe('你好世界一二三');
    });

    it('tool_calls 脚本经流式聚合后保留 tool_calls', async () => {
        const scripted = new AIMessage({
            content: '我先算一下',
            tool_calls: [
                {
                    name: 'calculator',
                    args: { expression: '1+1' },
                    id: 'call_1',
                    type: 'tool_call',
                },
            ],
        });
        const model = new FakeChatModel({ responses: [scripted] });

        const stream = await model.stream([new HumanMessage('1+1 等于几')]);
        let aggregated: AIMessageChunk | undefined;
        for await (const chunk of stream) {
            aggregated = aggregated === undefined ? chunk : concat(aggregated, chunk);
        }

        expect(aggregated?.content).toContain('我先算一下');
        expect(aggregated?.tool_calls?.[0]?.name).toBe('calculator');
        expect(aggregated?.tool_calls?.[0]?.args).toEqual({ expression: '1+1' });
    });

    it('calls 记录收到的消息', async () => {
        const model = new FakeChatModel({ responses: ['ok'] });
        await model.invoke([new HumanMessage('你好')]);
        expect(model.calls).toHaveLength(1);
        expect(model.calls[0]?.[0]?.content).toBe('你好');
    });
});
