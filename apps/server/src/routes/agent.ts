/**
 * Agent 接口层：三条路由 + 两类「翻译」工作。
 *
 * 路由：
 * - POST /agent/chat         同步对话
 * - POST /agent/chat/stream  SSE 流式对话
 * - GET  /agent/threads/:id  会话历史
 *
 * 翻译一：HTTP 入参 → 图调用。用 zod 校验（失败自动变 422，由 error 中间件接管）。
 * 翻译二：错误 → HTTP 语义。图运行失败统一转 502 AGENT_ERROR（细节进日志、
 * 不外漏给客户端）；未知 thread 转 404；非法 threadId 转 422。
 */
import Router from '@koa/router';
import { AIMessage, type BaseMessage, RemoveMessage, ToolMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { type ChartSpec, parseChartResult } from '../agent/chart-tool.js';
import { type createAgentGraph, lastAiReply, newThreadId } from '../agent/graph.js';
import { TokenStreamHandler } from '../agent/streaming.js';
import type { ThreadStore } from '../agent/threads.js';
import { addUsage, hasUsage, sumUsage, type TokenUsage } from '../agent/usage.js';
import { THREAD_ID_PATTERN } from '../config.js';
import { HttpError } from '../errors.js';
import type { LogFn } from '../middleware/logger.js';
import { initSse, writeSseComment, writeSseEvent } from '../sse.js';

/** 从工厂函数反推「编译后的图」类型（避免手写 CompiledStateGraph 一长串泛型）。 */
type AgentGraph = ReturnType<typeof createAgentGraph>;

/**
 * 对话请求体 schema。三个细节：
 * - `.trim()`：先去空白再算长度 —— "   " 会被判为空；
 * - `.strict()`：拒绝未知字段（早暴露拼写错误，如误传 `prompt`）；
 * - 自定义错误信息会出现在 422 响应的 details 里，尽量写给人看。
 */
const chatRequestSchema = z
    .object({
        message: z
            .string()
            .trim()
            .min(1, 'message 不能为空')
            .max(4000, 'message 超长（最多 4000 字符）'),
        threadId: z.string().regex(THREAD_ID_PATTERN, 'threadId 格式不合法').optional(),
    })
    .strict();

export interface AgentRouterOptions {
    graph: AgentGraph;
    log?: LogFn;
    /** 会话列表 / 删除（checkpointer 存储层）；省略时列表为空、删除 404。 */
    threads?: ThreadStore;
}

/**
 * 同步调用图并取回复。graph.invoke 的输入只需要「本轮新消息」——
 * 历史会由 checkpointer 按 configurable.thread_id 自动恢复。
 * 任何图内错误（模型 4xx/5xx、网络失败……）统一收敛为 502：
 * 记录真实原因到日志，对外只给稳定的错误码。
 */
async function invokeAgent(
    graph: AgentGraph,
    message: string,
    threadId: string,
    log?: LogFn,
): Promise<{ reply: string; usage: TokenUsage | null }> {
    try {
        const config = { configurable: { thread_id: threadId } };
        // 本轮用量 = invoke 前后全量 diff（result.messages 含整个历史，不能直接加总）
        const stateBefore = await graph.getState(config);
        const before = sumUsage(
            (stateBefore.values as { messages?: BaseMessage[] }).messages ?? [],
        );
        const result = await graph.invoke(
            { messages: [{ role: 'user', content: message }] },
            config,
        );
        const after = sumUsage(result.messages);
        const usage: TokenUsage = {
            inputTokens: after.inputTokens - before.inputTokens,
            outputTokens: after.outputTokens - before.outputTokens,
            totalTokens: after.totalTokens - before.totalTokens,
        };
        return { reply: lastAiReply(result.messages), usage: hasUsage(usage) ? usage : null };
    } catch (err) {
        log?.({
            level: 'error',
            message: 'agent 运行失败',
            error: err instanceof Error ? err.message : String(err),
        });
        throw new HttpError(502, 'AGENT_ERROR', 'Agent 运行失败');
    }
}

/**
 * 从 AIMessage 提取可读的 tool_calls（name + args）。
 * args 序列化截断到 500 字符 —— 工具帧是给用户看的「执行过程」，
 * 不是数据通道；模型要数据会走 ToolMessage。
 */
function readableToolCalls(message: AIMessage): { name: string; args: string }[] {
    return (message.tool_calls ?? []).map((call) => ({
        name: call.name,
        args: JSON.stringify(call.args ?? {}).slice(0, 500),
    }));
}

/**
 * 提取 AI 消息 content 块里的 reasoning 文本（思考过程）；无则空串。
 * 流式路径下推理内容以 `{type:'reasoning', reasoning}` 块存进消息（见 §6-4 content-blocks）。
 */
function reasoningTextOf(message: BaseMessage): string {
    const content = message.content;
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .filter(
            (block): block is { type: string; reasoning: string } =>
                typeof block === 'object' &&
                block !== null &&
                (block as { type?: unknown }).type === 'reasoning' &&
                typeof (block as { reasoning?: unknown }).reasoning === 'string',
        )
        .map((block) => block.reasoning)
        .join('\n');
}

/**
 * 把 checkpointer 里的完整消息流映射成「人类可读的历史」：
 * 只保留 user（human）与 assistant（ai）的文本消息；
 * ToolMessage 与「只有工具调用没有文本」的 AI 消息都折叠掉
 * —— 它们属于内部执行细节，不属于对话本身。
 *
 * 用 `message.text` 取文本：流式（stream-events 协议）路径下 AI 消息的
 * content 是 content-blocks 数组（reasoning/text 混合），老写法只认字符串
 * 会把助手回复整体丢掉（表现为历史只剩提问）；`.text` 对两种形态都兼容。
 * assistant 消息另带 `reasoning`（思考过程，前端按浅色过程样式展示）。
 */
function toHistory(messages: BaseMessage[]): {
    role: 'user' | 'assistant';
    content: string;
    reasoning?: string;
    charts?: ChartSpec[];
    usage?: TokenUsage;
}[] {
    const history: {
        role: 'user' | 'assistant';
        content: string;
        reasoning?: string;
        charts?: ChartSpec[];
        usage?: TokenUsage;
    }[] = [];
    /** 本轮的图表（render_chart 工具结果），附加到该轮最终的助手消息上。 */
    let pendingCharts: ChartSpec[] = [];
    /** 本轮的 token 用量（跨工具轮累加），同样附加到该轮助手消息。 */
    let pendingUsage: TokenUsage | null = null;

    for (const message of messages) {
        const type = message.getType();
        if (type === 'tool') {
            if (message instanceof ToolMessage && message.name === 'render_chart') {
                const spec = parseChartResult(String(message.content));
                if (spec !== null) {
                    pendingCharts.push(spec);
                }
            }
            continue;
        }
        if (type !== 'human' && type !== 'ai') {
            continue;
        }
        if (type === 'human') {
            // 上一轮已随其助手消息落档；新提问开启新一轮
            pendingCharts = [];
            pendingUsage = null;
        }
        if (type === 'ai') {
            // 先累计用量（工具轮的 AI 消息文本为空，也必须计入）
            const turnUsage = sumUsage([message]);
            if (hasUsage(turnUsage)) {
                pendingUsage =
                    pendingUsage === null ? turnUsage : addUsage(pendingUsage, turnUsage);
            }
        }
        const text = message.text;
        if (text.length === 0) {
            continue;
        }
        const entry: {
            role: 'user' | 'assistant';
            content: string;
            reasoning?: string;
            charts?: ChartSpec[];
            usage?: TokenUsage;
        } = {
            role: type === 'human' ? 'user' : 'assistant',
            content: text,
        };
        if (type === 'ai') {
            const reasoning = reasoningTextOf(message);
            if (reasoning.length > 0) {
                entry.reasoning = reasoning;
            }
            if (pendingCharts.length > 0) {
                entry.charts = pendingCharts;
                pendingCharts = [];
            }
            if (pendingUsage !== null) {
                entry.usage = pendingUsage;
                pendingUsage = null;
            }
        }
        history.push(entry);
    }
    return history;
}

export function agentRouter(options: AgentRouterOptions): Router {
    const router = new Router({ prefix: '/agent' });

    /** 会话列表：按最后活跃时间倒序（含首条消息预览），供侧栏展示。 */
    router.get('/threads', async (ctx) => {
        const threads = options.threads === undefined ? [] : await options.threads.list();
        ctx.body = { threads };
    });

    /**
     * 删除会话：连同 checkpointer 里的记录一并清除（不可恢复）。
     * 先查 state 以区分「未知会话」→ 404；存在才删。
     */
    router.delete('/threads/:threadId', async (ctx) => {
        const threadId = ctx.params.threadId ?? '';
        if (!THREAD_ID_PATTERN.test(threadId)) {
            throw new HttpError(422, 'VALIDATION_ERROR', 'threadId 格式不合法');
        }
        if (options.threads === undefined) {
            throw new HttpError(404, 'NOT_FOUND', '会话存储未启用');
        }
        const state = await options.graph.getState({ configurable: { thread_id: threadId } });
        const messages = (state.values as { messages?: BaseMessage[] }).messages ?? [];
        if (messages.length === 0) {
            throw new HttpError(404, 'NOT_FOUND', '会话不存在');
        }
        await options.threads.remove(threadId);
        ctx.body = { threadId, deleted: true };
    });

    /** 同步对话：一次请求拿完整回复（内部可能已跑完多轮工具调用）。 */
    router.post('/chat', async (ctx) => {
        // 校验失败会抛 ZodError → error 中间件统一转 422 + details
        const body = chatRequestSchema.parse(ctx.request.body);
        const threadId = body.threadId ?? newThreadId(); // 不传则自动开新会话
        const { reply, usage } = await invokeAgent(
            options.graph,
            body.message,
            threadId,
            options.log,
        );
        ctx.body = { threadId, reply, ...(usage !== null ? { usage } : {}) };
    });

    /** 会话历史：直接读 checkpointer 的状态快照。 */
    router.get('/threads/:threadId', async (ctx) => {
        const threadId = ctx.params.threadId ?? '';
        if (!THREAD_ID_PATTERN.test(threadId)) {
            throw new HttpError(422, 'VALIDATION_ERROR', 'threadId 格式不合法');
        }

        const state = await options.graph.getState({ configurable: { thread_id: threadId } });
        const messages = (state.values as { messages?: BaseMessage[] }).messages ?? [];
        if (messages.length === 0) {
            // 未知 thread 与「空会话」等价：都没聊过 → 404
            throw new HttpError(404, 'NOT_FOUND', '会话不存在');
        }

        ctx.body = { threadId, messages: toHistory(messages) };
    });

    /**
     * 撤回：删除「最后一条用户消息及其之后的全部消息」（含助手回复与工具轮）。
     * 用 LangGraph 的 RemoveMessage 写回状态 —— 被撤回的问答从上下文消失，
     * 下一轮对话从撤回点之前继续（等价于"重新编辑后再问"）。
     * 前端把它做成「撤回并把问题填回输入框」。
     */
    router.post('/threads/:threadId/rewind', async (ctx) => {
        const threadId = ctx.params.threadId ?? '';
        if (!THREAD_ID_PATTERN.test(threadId)) {
            throw new HttpError(422, 'VALIDATION_ERROR', 'threadId 格式不合法');
        }

        const config = { configurable: { thread_id: threadId } };
        const state = await options.graph.getState(config);
        const messages = (state.values as { messages?: BaseMessage[] }).messages ?? [];

        let lastHumanIndex = -1;
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i]?.getType() === 'human') {
                lastHumanIndex = i;
                break;
            }
        }
        if (lastHumanIndex === -1) {
            throw new HttpError(404, 'NOT_FOUND', '没有可撤回的消息');
        }

        const removals = messages
            .slice(lastHumanIndex)
            .map((message) =>
                message.id === undefined ? null : new RemoveMessage({ id: message.id }),
            )
            .filter((message): message is RemoveMessage => message !== null);
        await options.graph.updateState(config, { messages: removals });

        ctx.body = { threadId, removedCount: removals.length };
    });

    /** SSE 流式对话：逐 token 推送 + 结束帧。 */
    router.post('/chat/stream', async (ctx) => {
        const body = chatRequestSchema.parse(ctx.request.body);
        const threadId = body.threadId ?? newThreadId();

        // 关键：关闭 Koa 的响应封装，改由我们直接操作原生 res 写 SSE。
        // 之后 Koa 不会再往这个响应里写任何东西（包括错误页）。
        ctx.respond = false;
        const res = ctx.res;
        initSse(res);

        // 心跳：每 15s 一个注释帧，防止中间代理因空闲断连长连接。
        // unref()：不因为这个定时器阻止进程退出。
        const heartbeat = setInterval(() => writeSseComment(res, 'ping'), 15_000);
        heartbeat.unref();

        // 逐 token 处理器：正文分片 → message.delta；思考分片 → reasoning.delta
        const handler = new TokenStreamHandler(
            (text) => {
                writeSseEvent(res, 'message.delta', { text });
            },
            (text) => {
                writeSseEvent(res, 'reasoning.delta', { text });
            },
        );

        try {
            // streamMode:'updates'：按节点产出状态更新。除了拿 model 节点最终回复做
            // 兜底，还能从更新序列里提取「工具调用过程」给前端展示：
            //   model 更新（AIMessage 带 tool_calls）→ tool.start（含模型的过程文本）
            //   tools 更新（ToolMessage[]）        → tool.end（含执行结果）
            // 时序天然正确：模型决定调工具 → 工具执行 → 模型继续。
            let fallbackReply = '';
            /** 本轮 token 用量：从 model 节点更新累计（工具轮多次调用逐次相加）。 */
            let turnUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
            const stream = await options.graph.stream(
                { messages: [{ role: 'user', content: body.message }] },
                {
                    configurable: { thread_id: threadId },
                    streamMode: 'updates',
                    callbacks: [handler],
                },
            );
            for await (const update of stream) {
                const modelUpdate = (update as { model?: { messages?: BaseMessage[] } }).model;
                const toolsUpdate = (update as { tools?: { messages?: BaseMessage[] } }).tools;

                if (modelUpdate?.messages !== undefined) {
                    fallbackReply = lastAiReply(modelUpdate.messages);
                    turnUsage = addUsage(turnUsage, sumUsage(modelUpdate.messages));
                    const lastAi = modelUpdate.messages.findLast(
                        (message): message is AIMessage =>
                            message instanceof AIMessage && (message.tool_calls?.length ?? 0) > 0,
                    );
                    if (lastAi !== undefined) {
                        const thought =
                            typeof lastAi.content === 'string' ? lastAi.content.trim() : '';
                        writeSseEvent(res, 'tool.start', {
                            calls: readableToolCalls(lastAi),
                            ...(thought.length > 0 ? { thought } : {}),
                        });
                    }
                }

                if (toolsUpdate?.messages !== undefined) {
                    // render_chart 的规格从**完整消息内容**解析（tool.end 帧是截断文本），
                    // 单独发 `chart` 帧给前端实时渲染
                    for (const message of toolsUpdate.messages) {
                        if (message instanceof ToolMessage && message.name === 'render_chart') {
                            const spec = parseChartResult(String(message.content));
                            if (spec !== null) {
                                writeSseEvent(res, 'chart', { spec });
                            }
                        }
                    }
                    const results = toolsUpdate.messages
                        .filter(
                            (message): message is ToolMessage =>
                                message instanceof ToolMessage && message.name !== undefined,
                        )
                        .map((message) => ({
                            name: message.name as string,
                            result: String(message.content).slice(0, 2000),
                        }));
                    if (results.length > 0) {
                        writeSseEvent(res, 'tool.end', { results });
                    }
                }
            }
            const reply = handler.reply.length > 0 ? handler.reply : fallbackReply;
            if (hasUsage(turnUsage)) {
                writeSseEvent(res, 'usage', turnUsage);
            }
            writeSseEvent(res, 'message.done', { threadId, reply });
        } catch (err) {
            options.log?.({
                level: 'error',
                message: 'agent 流式运行失败',
                error: err instanceof Error ? err.message : String(err),
            });
            // 注意：响应头早已发出（200），错误只能以 error 帧表达，客户端按帧处理
            writeSseEvent(res, 'error', { code: 'AGENT_ERROR', message: 'Agent 运行失败' });
        } finally {
            // 无论成功失败：清心跳、关连接，避免悬挂的 SSE 长连接
            clearInterval(heartbeat);
            if (!res.writableEnded) {
                res.end();
            }
        }
    });

    return router;
}
