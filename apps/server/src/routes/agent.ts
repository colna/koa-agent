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
import type { BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { type createAgentGraph, lastAiReply, newThreadId } from '../agent/graph.js';
import { TokenStreamHandler } from '../agent/streaming.js';
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
): Promise<string> {
    try {
        const result = await graph.invoke(
            { messages: [{ role: 'user', content: message }] },
            { configurable: { thread_id: threadId } },
        );
        return lastAiReply(result.messages);
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
 * 把 checkpointer 里的完整消息流映射成「人类可读的历史」：
 * 只保留 user（human）与 assistant（ai）的文本消息；
 * ToolMessage 与「只有工具调用没有文本」的 AI 消息都折叠掉
 * —— 它们属于内部执行细节，不属于对话本身。
 */
function toHistory(messages: BaseMessage[]): { role: 'user' | 'assistant'; content: string }[] {
    const history: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const message of messages) {
        const type = message.getType();
        if (
            (type === 'human' || type === 'ai') &&
            typeof message.content === 'string' &&
            message.content.length > 0
        ) {
            history.push({
                role: type === 'human' ? 'user' : 'assistant',
                content: message.content,
            });
        }
    }
    return history;
}

export function agentRouter(options: AgentRouterOptions): Router {
    const router = new Router({ prefix: '/agent' });

    /** 同步对话：一次请求拿完整回复（内部可能已跑完多轮工具调用）。 */
    router.post('/chat', async (ctx) => {
        // 校验失败会抛 ZodError → error 中间件统一转 422 + details
        const body = chatRequestSchema.parse(ctx.request.body);
        const threadId = body.threadId ?? newThreadId(); // 不传则自动开新会话
        const reply = await invokeAgent(options.graph, body.message, threadId, options.log);
        ctx.body = { threadId, reply };
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

        // 逐 token 处理器：模型每吐一个分片 → 立刻写一帧 message.delta
        const handler = new TokenStreamHandler((text) => {
            writeSseEvent(res, 'message.delta', { text });
        });

        try {
            // streamMode:'updates' 会按节点产出状态更新（拿来做 reply 兜底）；
            // callbacks 里的 handler 声明了 prefer stream events，
            // 模型调用会自动走逐 token 回调（机制详见 src/agent/streaming.ts）。
            let fallbackReply = '';
            const stream = await options.graph.stream(
                { messages: [{ role: 'user', content: body.message }] },
                {
                    configurable: { thread_id: threadId },
                    streamMode: 'updates',
                    callbacks: [handler],
                },
            );
            for await (const update of stream) {
                // 兜底：某些模型可能不产生 token 事件（拿不到增量），
                // 那就从 model 节点的最终更新里提取整段回复。
                const modelUpdate = (update as { model?: { messages?: BaseMessage[] } }).model;
                if (modelUpdate?.messages !== undefined) {
                    fallbackReply = lastAiReply(modelUpdate.messages);
                }
            }
            const reply = handler.reply.length > 0 ? handler.reply : fallbackReply;
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
