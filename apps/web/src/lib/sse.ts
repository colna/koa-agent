/**
 * SSE（Server-Sent Events）帧解析器 —— 纯函数，方便单测。
 *
 * 协议回顾（与服务端 apps/server/src/sse.ts 对应）：
 *   帧 = 若干行 + 空行结尾；`event:` 指定事件名，`data:` 携带一行 JSON；
 *   以 `:` 开头的行是注释（心跳），直接忽略。
 *
 * 为什么需要「带 rest 返回」的解析：网络分片不会按帧对齐 —— 一次 read()
 * 可能恰好把一帧切成两半（半帧先留在 buffer，等下一片拼接后再切），
 * 也可能一次包含好几帧。所以解析函数接收「缓冲文本」，返回
 * `frames`（本次切出的完整帧）与 `rest`（未完成的尾巴）。
 */
export interface SseFrame {
    event: string;
    data: string;
}

export function parseSseChunk(buffer: string): { frames: SseFrame[]; rest: string } {
    const frames: SseFrame[] = [];
    let rest = buffer;

    for (;;) {
        const boundary = rest.indexOf('\n\n');
        if (boundary === -1) {
            break;
        }
        const block = rest.slice(0, boundary);
        rest = rest.slice(boundary + 2);
        const frame = parseBlock(block);
        if (frame !== null) {
            frames.push(frame);
        }
    }

    return { frames, rest };
}

function parseBlock(block: string): SseFrame | null {
    let event = '';
    const dataLines: string[] = [];

    for (const line of block.split('\n')) {
        if (line.length === 0 || line.startsWith(':')) {
            continue; // 空行与注释帧（服务端心跳 `: ping`）忽略
        }
        if (line.startsWith('event:')) {
            event = line.slice('event:'.length).trim();
        } else if (line.startsWith('data:')) {
            // 规范里 data 可多行，最终以换行拼接
            dataLines.push(line.slice('data:'.length).trimStart());
        }
    }

    if (dataLines.length === 0) {
        return null;
    }
    return { event: event.length > 0 ? event : 'message', data: dataLines.join('\n') };
}
