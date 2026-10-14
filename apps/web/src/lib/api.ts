/**
 * server API 封装：健康检查 / 会话历史 / SSE 流式对话。
 *
 * 架构备注：浏览器「直连」server（默认 127.0.0.1:3000），不经过 Next 代理层 ——
 * 依据知识库教训：反代层很容易把流式响应整段缓冲，直连链路最短最稳。
 * 跨域由 server 的 CORS 中间件放行（见 apps/server/src/middleware/cors.ts）。
 */
import { parseSseChunk } from './sse';

export const SERVER_URL: string = process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://127.0.0.1:3000';

export interface ChatMessage {
    /** 稳定 id（列表 key 与未来扩展用；历史回读时本地生成）。 */
    id: string;
    role: 'user' | 'assistant';
    content: string;
    /** 是否仍在流式接收（用于渲染光标）。 */
    streaming?: boolean;
    /** 是否为错误提示气泡。 */
    error?: boolean;
}

export interface StreamChatHandlers {
    onDelta: (text: string) => void;
    onDone: (payload: { threadId: string; reply: string }) => void;
    onError: (error: { code: string; message: string }) => void;
}

/** 客户端生成会话 ID（格式与服务端 THREAD_ID_PATTERN 一致）。 */
export function newThreadId(): string {
    return `t_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

/** 健康检查（带 2.5s 超时），失败返回 false，不抛异常。 */
export async function fetchHealth(baseUrl: string = SERVER_URL): Promise<boolean> {
    try {
        const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2500) });
        return res.ok;
    } catch {
        return false;
    }
}

/** 读取会话历史；未知会话（404）或网络失败返回 null（调用方保持空态即可）。 */
export async function fetchHistory(
    threadId: string,
    baseUrl: string = SERVER_URL,
): Promise<ChatMessage[] | null> {
    try {
        const res = await fetch(`${baseUrl}/agent/threads/${encodeURIComponent(threadId)}`);
        if (!res.ok) {
            return null;
        }
        const body = (await res.json()) as { messages?: { role: string; content: string }[] };
        return (body.messages ?? []).map((message) => ({
            id: crypto.randomUUID(),
            role: message.role === 'user' ? ('user' as const) : ('assistant' as const),
            content: message.content,
        }));
    } catch {
        return null;
    }
}

/**
 * SSE 流式对话：POST 后持续读取响应流，按帧回调。
 * 为什么不用浏览器原生 EventSource？—— 它只支持 GET，而我们的接口是 POST + JSON。
 */
export async function streamChat(
    input: { message: string; threadId: string; signal?: AbortSignal },
    handlers: StreamChatHandlers,
    baseUrl: string = SERVER_URL,
): Promise<void> {
    const res = await fetch(`${baseUrl}/agent/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: input.message, threadId: input.threadId }),
        signal: input.signal,
    });

    // 非 200（校验失败 / 服务错误）：响应是 JSON 错误信封，而非 SSE 流
    if (!res.ok || res.body === null) {
        const error = await readErrorEnvelope(res);
        handlers.onError(error);
        return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        buffer += decoder.decode(value, { stream: true });
        const { frames, rest } = parseSseChunk(buffer);
        buffer = rest;
        for (const frame of frames) {
            const data = asRecord(safeJsonParse(frame.data));
            if (frame.event === 'message.delta' && typeof data?.text === 'string') {
                handlers.onDelta(data.text);
            } else if (frame.event === 'message.done') {
                handlers.onDone({
                    threadId: typeof data?.threadId === 'string' ? data.threadId : input.threadId,
                    reply: typeof data?.reply === 'string' ? data.reply : '',
                });
            } else if (frame.event === 'error') {
                handlers.onError({
                    code: typeof data?.code === 'string' ? data.code : 'AGENT_ERROR',
                    message: typeof data?.message === 'string' ? data.message : 'Agent 运行失败',
                });
            }
        }
    }
}

async function readErrorEnvelope(res: Response): Promise<{ code: string; message: string }> {
    try {
        const body = asRecord(await res.json());
        const error = asRecord(body?.error);
        return {
            code: typeof error?.code === 'string' ? error.code : 'HTTP_ERROR',
            message:
                typeof error?.message === 'string'
                    ? error.message
                    : `请求失败（HTTP ${res.status}）`,
        };
    } catch {
        return { code: 'HTTP_ERROR', message: `请求失败（HTTP ${res.status}）` };
    }
}

function safeJsonParse(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}
