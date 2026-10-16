/**
 * server API 封装：健康检查 / 会话历史 / SSE 流式对话。
 *
 * 架构备注：浏览器「直连」server（默认 127.0.0.1:3000），不经过 Next 代理层 ——
 * 依据知识库教训：反代层很容易把流式响应整段缓冲，直连链路最短最稳。
 * 跨域由 server 的 CORS 中间件放行（见 apps/server/src/middleware/cors.ts）。
 */
import { parseSseChunk } from './sse';

export const SERVER_URL: string = process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://127.0.0.1:3000';

/** 图表规格（与 server `chart-tool.ts` 的 ChartSpec 保持同一数据契约）。 */
export interface ChartSpec {
    kind: 'line' | 'bar' | 'pie';
    title: string;
    /** 类目轴标签（pie 为各扇区名称）。 */
    categories: string[];
    /** 数据系列；pie 只取第一个。 */
    series: { name: string; data: number[] }[];
    /** 数值单位（y 轴展示）。 */
    unit?: string;
}

/** 一轮对话的 token 消耗（与 server `agent/usage.ts` 的 TokenUsage 契约一致）。 */
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
}

export interface ChatMessage {
    /** 稳定 id（列表 key 与未来扩展用；历史回读时本地生成）。 */
    id: string;
    role: 'user' | 'assistant';
    content: string;
    /** 模型的思考过程（reasoning 流式累积；浅色过程样式展示）。 */
    reasoning?: string;
    /** 图表（render_chart 工具产出；流式与历史回读均可能有）。 */
    charts?: ChartSpec[];
    /** 本轮 token 用量（跨工具轮累加；流式在收尾帧 / 历史随消息返回）。 */
    usage?: TokenUsage;
    /** 是否仍在流式接收（用于渲染光标）。 */
    streaming?: boolean;
    /** 是否为错误提示气泡。 */
    error?: boolean;
    /** 工具调用过程（assistant 消息专属；流式与历史回读均可能有）。 */
    toolEvents?: ToolEvent[];
}

/** 一次工具调用的展示态（由 tool.start / tool.end 帧累积）。 */
export interface ToolEvent {
    /** 工具名，如 sp_query_script_errors / sls_query_log。 */
    name: string;
    /** 调用参数（JSON 字符串，服务端已截断）。 */
    args?: string;
    /** 模型在调用前的过程文本（「我先查一下近 7 天…」）。 */
    thought?: string;
    /** 执行结果（tool.end 到达前为 undefined = 执行中）。 */
    result?: string;
}

export interface StreamChatHandlers {
    onDelta: (text: string) => void;
    /** 思考过程增量（model reasoning 流）。 */
    onReasoning?: (text: string) => void;
    onDone: (payload: { threadId: string; reply: string }) => void;
    onError: (error: { code: string; message: string }) => void;
    /** 工具开始调用（模型已决定调哪些工具）。 */
    onToolStart?: (payload: { calls: { name: string; args: string }[]; thought?: string }) => void;
    /** 工具执行完毕（带结果）。 */
    onToolEnd?: (payload: { results: { name: string; result: string }[] }) => void;
    /** 图表（render_chart 工具产出）。 */
    onChart?: (spec: ChartSpec) => void;
    /** 本轮 token 用量（收尾帧，含工具轮累加）。 */
    onUsage?: (usage: TokenUsage) => void;
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
        const body = (await res.json()) as {
            messages?: {
                role: string;
                content: string;
                reasoning?: string;
                charts?: unknown;
                usage?: unknown;
            }[];
        };
        return (body.messages ?? []).map((message) => ({
            id: crypto.randomUUID(),
            role: message.role === 'user' ? ('user' as const) : ('assistant' as const),
            content: message.content,
            ...(typeof message.reasoning === 'string' && message.reasoning.length > 0
                ? { reasoning: message.reasoning }
                : {}),
            ...(Array.isArray(message.charts)
                ? { charts: message.charts.filter(isChartSpec) }
                : {}),
            ...(isTokenUsage(message.usage) ? { usage: message.usage } : {}),
        }));
    } catch {
        return null;
    }
}

/**
 * 撤回最后一轮问答（服务端删除「最后一条用户消息及其之后」的消息）。
 * 返回是否成功；失败（网络 / 404）由调用方决定不动作。
 */
export async function rewindThread(
    threadId: string,
    baseUrl: string = SERVER_URL,
): Promise<boolean> {
    try {
        const res = await fetch(`${baseUrl}/agent/threads/${encodeURIComponent(threadId)}/rewind`, {
            method: 'POST',
        });
        return res.ok;
    } catch {
        return false;
    }
}

/** 会话摘要（GET /agent/threads 列表项）。 */
export interface ThreadSummary {
    threadId: string;
    /** 首条用户消息预览（60 字内）。 */
    preview: string;
    /** 对话消息条数（user + 有文本的 assistant）。 */
    messageCount: number;
    /** 最后活跃时间（ISO 8601）。 */
    updatedAt: string;
}

/** 拉取会话列表（按最后活跃倒序）；失败返回 null（调用方保留旧列表）。 */
export async function fetchThreads(baseUrl: string = SERVER_URL): Promise<ThreadSummary[] | null> {
    try {
        const res = await fetch(`${baseUrl}/agent/threads`);
        if (!res.ok) {
            return null;
        }
        const body = (await res.json()) as { threads?: ThreadSummary[] };
        return Array.isArray(body.threads) ? body.threads : null;
    } catch {
        return null;
    }
}

/** 删除会话（服务端连同历史一并清除，不可恢复）；返回是否成功。 */
export async function deleteThread(
    threadId: string,
    baseUrl: string = SERVER_URL,
): Promise<boolean> {
    try {
        const res = await fetch(`${baseUrl}/agent/threads/${encodeURIComponent(threadId)}`, {
            method: 'DELETE',
        });
        return res.ok;
    } catch {
        return false;
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
            } else if (frame.event === 'reasoning.delta' && typeof data?.text === 'string') {
                handlers.onReasoning?.(data.text);
            } else if (frame.event === 'message.done') {
                handlers.onDone({
                    threadId: typeof data?.threadId === 'string' ? data.threadId : input.threadId,
                    reply: typeof data?.reply === 'string' ? data.reply : '',
                });
            } else if (frame.event === 'tool.start') {
                const calls = Array.isArray(data?.calls) ? data.calls.filter(isToolCall) : [];
                const thought = typeof data?.thought === 'string' ? data.thought : undefined;
                if (calls.length > 0 && handlers.onToolStart !== undefined) {
                    handlers.onToolStart({ calls, ...(thought !== undefined ? { thought } : {}) });
                }
            } else if (frame.event === 'tool.end') {
                const results = Array.isArray(data?.results)
                    ? data.results.filter(isToolResult)
                    : [];
                if (results.length > 0 && handlers.onToolEnd !== undefined) {
                    handlers.onToolEnd({ results });
                }
            } else if (frame.event === 'chart') {
                const spec = isChartSpec(data?.spec) ? data.spec : null;
                if (spec !== null && handlers.onChart !== undefined) {
                    handlers.onChart(spec);
                }
            } else if (frame.event === 'usage') {
                const usage = isTokenUsage(data) ? data : null;
                if (usage !== null && handlers.onUsage !== undefined) {
                    handlers.onUsage(usage);
                }
            } else if (frame.event === 'error') {
                handlers.onError({
                    code: typeof data?.code === 'string' ? data.code : 'AGENT_ERROR',
                    message: typeof data?.message === 'string' ? data.message : 'Agent 运行失败',
                });
            }
        }
    }
}

function isToolCall(value: unknown): value is { name: string; args: string } {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { name?: unknown }).name === 'string'
    );
}

function isToolResult(value: unknown): value is { name: string; result: string } {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { name?: unknown }).name === 'string' &&
        typeof (value as { result?: unknown }).result === 'string'
    );
}

/** 图表规格守卫（防御脏帧；与 server ChartSpec 契约一致）。 */
function isChartSpec(value: unknown): value is ChartSpec {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const spec = value as Partial<ChartSpec>;
    return (
        (spec.kind === 'line' || spec.kind === 'bar' || spec.kind === 'pie') &&
        typeof spec.title === 'string' &&
        Array.isArray(spec.categories) &&
        Array.isArray(spec.series) &&
        spec.series.every(
            (s) =>
                typeof s === 'object' &&
                s !== null &&
                typeof (s as { name?: unknown }).name === 'string' &&
                Array.isArray((s as { data?: unknown }).data),
        )
    );
}

/** token 用量守卫。 */
function isTokenUsage(value: unknown): value is TokenUsage {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const usage = value as Partial<TokenUsage>;
    return (
        typeof usage.inputTokens === 'number' &&
        typeof usage.outputTokens === 'number' &&
        typeof usage.totalTokens === 'number'
    );
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
