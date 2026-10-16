/**
 * TokenStreamHandler 单元测试：多消息场景下 current/last 双缓冲的切换
 * （模拟"工具轮前言 + 最终回答"两段消息，验证 reply 只取最终段）。
 */
import type { ChatModelStreamEvent } from '@langchain/core/language_models/event';
import { describe, expect, it } from 'vitest';
import { TokenStreamHandler } from './streaming.js';

function evt(event: unknown): ChatModelStreamEvent {
    return event as ChatModelStreamEvent;
}

describe('TokenStreamHandler', () => {
    it('累积分片、message-finish 提交、message-start 重置', () => {
        const deltas: string[] = [];
        const handler = new TokenStreamHandler((text) => deltas.push(text));

        handler.handleChatModelStreamEvent(evt({ event: 'message-start', id: 'm1' }), 'run1');
        handler.handleChatModelStreamEvent(
            evt({
                event: 'content-block-delta',
                index: 0,
                delta: { type: 'text-delta', text: '我先算一下' },
            }),
            'run1',
        );
        handler.handleChatModelStreamEvent(evt({ event: 'message-finish' }), 'run1');

        handler.handleChatModelStreamEvent(evt({ event: 'message-start', id: 'm2' }), 'run1');
        handler.handleChatModelStreamEvent(
            evt({
                event: 'content-block-delta',
                index: 0,
                delta: { type: 'text-delta', text: '答案' },
            }),
            'run1',
        );
        handler.handleChatModelStreamEvent(
            evt({
                event: 'content-block-delta',
                index: 0,
                delta: { type: 'text-delta', text: '是 7' },
            }),
            'run1',
        );
        handler.handleChatModelStreamEvent(evt({ event: 'message-finish' }), 'run1');

        expect(deltas.join('')).toBe('我先算一下答案是 7');
        expect(handler.reply).toBe('答案是 7');
    });

    it('忽略非文本 delta 与其他事件', () => {
        const deltas: string[] = [];
        const handler = new TokenStreamHandler((text) => deltas.push(text));

        handler.handleChatModelStreamEvent(evt({ event: 'message-start', id: 'm1' }), 'run1');
        handler.handleChatModelStreamEvent(
            evt({
                event: 'content-block-delta',
                index: 0,
                delta: { type: 'block-delta', fields: {} },
            }),
            'run1',
        );
        handler.handleChatModelStreamEvent(evt({ event: 'usage', usage: {} }), 'run1');

        expect(deltas).toEqual([]);
        expect(handler.reply).toBe('');
    });

    it('reasoning-delta → onReasoning 外发；不混入 reply/正文', () => {
        const deltas: string[] = [];
        const reasonings: string[] = [];
        const handler = new TokenStreamHandler(
            (text) => deltas.push(text),
            (text) => reasonings.push(text),
        );

        handler.handleChatModelStreamEvent(evt({ event: 'message-start', id: 'm1' }), 'run1');
        handler.handleChatModelStreamEvent(
            evt({
                event: 'content-block-delta',
                index: 0,
                delta: { type: 'reasoning-delta', reasoning: '先分析问题' },
            }),
            'run1',
        );
        handler.handleChatModelStreamEvent(
            evt({
                event: 'content-block-delta',
                index: 1,
                delta: { type: 'text-delta', text: '答案是 7' },
            }),
            'run1',
        );
        handler.handleChatModelStreamEvent(evt({ event: 'message-finish' }), 'run1');

        expect(reasonings.join('')).toBe('先分析问题');
        expect(deltas.join('')).toBe('答案是 7');
        // reasoning 不参与「最终答复」判定
        expect(handler.reply).toBe('答案是 7');
    });
});
