/**
 * SSE 流式接口集成测试：自行解析 SSE 帧，断言 delta 拼接 = done.reply。
 * 覆盖「工具回合后流式」「普通回复」「运行失败 → error 帧」三场景；
 * 底层是 stream-events 协议回调（见 src/agent/streaming.ts）。
 */
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentGraph } from '../agent/graph.js';
import { createApp } from '../app.js';
import { type RunningServer, startServer } from '../server.js';
import { FakeChatModel } from '../testing/fake-model.js';
import { agentRouter } from './agent.js';

function toolCallResponse(): AIMessage {
    return new AIMessage({
        content: '',
        tool_calls: [
            { name: 'calculator', args: { expression: '1+2*3' }, id: 'call_1', type: 'tool_call' },
        ],
    });
}

const model = new FakeChatModel({
    responses: [toolCallResponse(), '答案是 7', '你好世界一二三'],
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

function postStream(body: unknown): Promise<Response> {
    return fetch(`${server.url}/agent/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

interface SseFrame {
    event: string;
    data: string;
}

function parseSse(text: string): SseFrame[] {
    return text
        .split('\n\n')
        .filter((block) => block.trim().length > 0 && !block.startsWith(':'))
        .map((block) => {
            const lines = block.split('\n');
            return {
                event: lines.find((line) => line.startsWith('event: '))?.slice(7) ?? '',
                data: lines.find((line) => line.startsWith('data: '))?.slice(6) ?? '',
            };
        });
}

describe('POST /agent/chat/stream', () => {
    it('工具回合后逐 token 输出并以 message.done 收尾', async () => {
        const res = await postStream({ message: '1+2*3 等于几', threadId: 't_stream_tool' });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');

        const frames = parseSse(await res.text());
        expect(frames.some((frame) => frame.event === 'error')).toBe(false);

        const deltas = frames
            .filter((frame) => frame.event === 'message.delta')
            .map((frame) => (JSON.parse(frame.data) as { text: string }).text);
        expect(deltas.length).toBeGreaterThan(1);
        expect(deltas.join('')).toBe('答案是 7');

        const done = frames.find((frame) => frame.event === 'message.done');
        expect(done).toBeDefined();
        expect(JSON.parse((done as SseFrame).data)).toEqual({
            threadId: 't_stream_tool',
            reply: '答案是 7',
        });

        const toolMessages = model.calls.at(-1) ?? [];
        expect(
            toolMessages.some(
                (message) => message instanceof ToolMessage && message.content === '7',
            ),
        ).toBe(true);
    });

    it('普通回复流式输出，done.reply 与 delta 拼接一致', async () => {
        const res = await postStream({ message: '说点长的', threadId: 't_stream_plain' });
        const frames = parseSse(await res.text());

        const deltas = frames
            .filter((frame) => frame.event === 'message.delta')
            .map((frame) => (JSON.parse(frame.data) as { text: string }).text);
        const done = frames.find((frame) => frame.event === 'message.done');

        expect(deltas.join('')).toBe('你好世界一二三');
        expect(JSON.parse((done as SseFrame).data)).toEqual({
            threadId: 't_stream_plain',
            reply: '你好世界一二三',
        });
    });

    it('运行失败 → error 帧且无 done 帧', async () => {
        const res = await postStream({ message: '这次会失败' });
        const frames = parseSse(await res.text());

        const error = frames.find((frame) => frame.event === 'error');
        expect(error).toBeDefined();
        const data = JSON.parse((error as SseFrame).data) as { code: string; message: string };
        expect(data.code).toBe('AGENT_ERROR');
        expect(data.message).not.toContain('用尽');
        expect(frames.some((frame) => frame.event === 'message.done')).toBe(false);
    });
});
