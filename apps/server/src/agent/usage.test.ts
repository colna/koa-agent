/**
 * 用量统计单测：sumUsage / addUsage / hasUsage。
 */
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { addUsage, hasUsage, sumUsage } from './usage.js';

describe('sumUsage', () => {
    it('累加 AI 消息的 usage_metadata；非 AI / 无 usage 的消息忽略', () => {
        const messages = [
            new HumanMessage('问'),
            new AIMessage({
                content: '答',
                usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
            }),
            new AIMessage({
                content: '',
                usage_metadata: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
            }),
            new AIMessage('无 usage 的消息'),
        ];
        expect(sumUsage(messages)).toEqual({
            inputTokens: 150,
            outputTokens: 30,
            totalTokens: 180,
        });
    });

    it('全空 → 全 0；hasUsage 判定', () => {
        const usage = sumUsage([new HumanMessage('hi')]);
        expect(usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
        expect(hasUsage(usage)).toBe(false);
        expect(hasUsage(addUsage(usage, { inputTokens: 1, outputTokens: 0, totalTokens: 1 }))).toBe(
            true,
        );
    });
});
