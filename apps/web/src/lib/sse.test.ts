/**
 * SSE 解析器单测：单帧 / 多帧 / 跨分片拼接 / 心跳注释 / 多行 data / 默认事件名。
 */
import { describe, expect, it } from 'vitest';
import { parseSseChunk } from './sse';

describe('parseSseChunk', () => {
    it('解析单帧', () => {
        const { frames, rest } = parseSseChunk('event: message.delta\ndata: {"text":"你"}\n\n');
        expect(frames).toEqual([{ event: 'message.delta', data: '{"text":"你"}' }]);
        expect(rest).toBe('');
    });

    it('一次解析多个帧，未完成的尾巴留在 rest', () => {
        const input =
            'event: message.delta\ndata: {"text":"你好"}\n\n' +
            'event: message.done\ndata: {"reply":"你好"}\n\n' +
            'event: message.delta\ndata: {"text":"半';
        const { frames, rest } = parseSseChunk(input);
        expect(frames).toHaveLength(2);
        expect(frames[0]?.event).toBe('message.delta');
        expect(frames[1]?.event).toBe('message.done');
        expect(rest).toBe('event: message.delta\ndata: {"text":"半');
    });

    it('跨分片拼接：半帧 + 补齐', () => {
        const first = parseSseChunk('event: message.delta\ndata: {"te');
        expect(first.frames).toHaveLength(0);
        const second = parseSseChunk(`${first.rest}xt":"你好"}\n\n`);
        expect(second.frames).toEqual([{ event: 'message.delta', data: '{"text":"你好"}' }]);
        expect(second.rest).toBe('');
    });

    it('忽略心跳注释帧', () => {
        const { frames } = parseSseChunk(': ping\n\nevent: message.delta\ndata: {"text":"a"}\n\n');
        expect(frames).toEqual([{ event: 'message.delta', data: '{"text":"a"}' }]);
    });

    it('data 多行以换行拼接；无 event 时默认 message', () => {
        const { frames } = parseSseChunk('data: line1\ndata: line2\n\n');
        expect(frames).toEqual([{ event: 'message', data: 'line1\nline2' }]);
    });
});
