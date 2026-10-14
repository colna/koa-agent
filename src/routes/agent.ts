import Router from '@koa/router';
import type { BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { type createAgentGraph, lastAiReply, newThreadId } from '../agent/graph.js';
import { TokenStreamHandler } from '../agent/streaming.js';
import { THREAD_ID_PATTERN } from '../config.js';
import { HttpError } from '../errors.js';
import type { LogFn } from '../middleware/logger.js';
import { initSse, writeSseComment, writeSseEvent } from '../sse.js';

type AgentGraph = ReturnType<typeof createAgentGraph>;

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

export function agentRouter(options: AgentRouterOptions): Router {
    const router = new Router({ prefix: '/agent' });

    router.post('/chat', async (ctx) => {
        const body = chatRequestSchema.parse(ctx.request.body);
        const threadId = body.threadId ?? newThreadId();
        const reply = await invokeAgent(options.graph, body.message, threadId, options.log);
        ctx.body = { threadId, reply };
    });

    router.post('/chat/stream', async (ctx) => {
        const body = chatRequestSchema.parse(ctx.request.body);
        const threadId = body.threadId ?? newThreadId();

        ctx.respond = false;
        const res = ctx.res;
        initSse(res);

        const heartbeat = setInterval(() => writeSseComment(res, 'ping'), 15_000);
        heartbeat.unref();

        const handler = new TokenStreamHandler((text) => {
            writeSseEvent(res, 'message.delta', { text });
        });

        try {
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
            writeSseEvent(res, 'error', { code: 'AGENT_ERROR', message: 'Agent 运行失败' });
        } finally {
            clearInterval(heartbeat);
            if (!res.writableEnded) {
                res.end();
            }
        }
    });

    return router;
}
