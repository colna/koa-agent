/**
 * FakeChatModel —— 给 LLM 写的「离线替身」，本项目测试策略的基石。
 *
 * 思路：继承 LangChain 的 `BaseChatModel`，只用脚本队列模拟模型行为：
 * 每次「调用模型」按顺序弹出一条预置响应（纯文本或带 tool_calls 的 AIMessage），
 * 于是可以精确编排「先要求调工具 → 再给出最终回答」这类多轮剧情，
 * 而整个测试套件零外网、零真实 API Key。
 *
 * 需要覆写的四个点（LangChain 对 ChatModel 的扩展点）：
 * - `_llmType()`      ：标识符（调试/追踪用）；
 * - `_generate()`     ：非流式路径 —— 普通 `model.invoke()` 走到这里；
 * - `_streamResponseChunks()`：流式路径 —— `model.stream()` 或
 *   「stream-events 回调」模式下走到这里（本项目 SSE 测试依赖它）；
 * - `bindTools()`     ：记录被绑定的工具（测试里断言"图确实把工具给了模型"）。
 *
 * 另外维护两个观察窗，供测试断言：
 * - `calls`      ：每次调用收到的完整消息列表（可断言多轮上下文、工具结果回灌）；
 * - `boundTools` ：最近一次 bindTools 收到的工具清单。
 */
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import {
    BaseChatModel,
    type BaseChatModelParams,
    type BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';

/** 脚本响应：纯字符串（当作纯文本回复）或完整 AIMessage（可携带 tool_calls）。 */
export type FakeChatResponse = AIMessage | string;

export interface FakeChatModelParams extends BaseChatModelParams {
    responses: FakeChatResponse[];
}

function textOf(message: AIMessage): string {
    return typeof message.content === 'string' ? message.content : '';
}

/** 把文本切成固定长度的分片（模拟流式输出；长度 4 让测试分片数可预期）。 */
function splitIntoChunks(text: string, size = 4): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += size) {
        chunks.push(text.slice(i, i + size));
    }
    return chunks;
}

export class FakeChatModel extends BaseChatModel {
    private readonly queue: FakeChatResponse[];
    /** 观察窗：每次调用收到的消息列表（测试断言用）。 */
    readonly calls: BaseMessage[][] = [];
    /** 观察窗：被绑定过的工具（测试断言用）。 */
    readonly boundTools: BindToolsInput[] = [];

    constructor(params: FakeChatModelParams) {
        super(params);
        this.queue = [...params.responses]; // 拷贝一份，避免外部改动影响脚本
    }

    override _llmType(): string {
        return 'fake-chat-model';
    }

    /**
     * 记录工具并返回自身 —— 真实模型会返回包装过的 Runnable（携带工具 schema），
     * 这里行为等价：FakeChatModel 本身就能"假装收到过定义"。
     */
    override bindTools(tools: BindToolsInput[]): this {
        this.boundTools.length = 0;
        this.boundTools.push(...tools);
        return this;
    }

    /** 非流式路径：弹出一条脚本响应，原样作为回复返回。 */
    override async _generate(
        messages: BaseMessage[],
        _options: this['ParsedCallOptions'],
        _runManager?: CallbackManagerForLLMRun,
    ): Promise<ChatResult> {
        this.calls.push(messages);
        const message = this.shiftMessage();
        return {
            generations: [{ text: textOf(message), message }],
        };
    }

    /**
     * 流式路径：把脚本响应「拆开」逐片吐出来。
     *
     * ⚠️ 关键教学点：流式模式下，上游会把我们 yield 的分片**聚合**成最终消息
     * ——聚合只会包含分片里出现过的东西。所以带 tool_calls 的脚本必须额外
     * yield 一个携带 `tool_call_chunks` 的分片重建工具调用，否则聚合后的
     * 消息会丢失 tool_calls，图就永远不会进入 tools 节点！
     * （这个坑在做 SSE 时实际踩过，见知识库 langgraph-js-streaming.md。）
     *
     * 末尾兜底：一个分片都没有时 yield 一个空分片 —— core 对「零分片」
     * 会直接抛 "Received empty response from chat model call."。
     */
    override async *_streamResponseChunks(
        messages: BaseMessage[],
        _options: this['ParsedCallOptions'],
        _runManager?: CallbackManagerForLLMRun,
    ): AsyncGenerator<ChatGenerationChunk> {
        this.calls.push(messages);
        const message = this.shiftMessage();
        const text = textOf(message);
        const toolCalls = message.tool_calls ?? [];
        let yielded = false;

        // 1) 文本分片（4 字一片，模拟逐 token）
        for (const piece of splitIntoChunks(text)) {
            yielded = true;
            yield new ChatGenerationChunk({
                text: piece,
                message: new AIMessageChunk({ content: piece }),
            });
        }

        // 2) 工具调用分片（若有）：args 以 JSON 字符串形式放进 tool_call_chunks
        if (toolCalls.length > 0) {
            yielded = true;
            const toolCallChunks = toolCalls.map((call, index) => ({
                name: call.name,
                args: JSON.stringify(call.args ?? {}),
                id: call.id,
                index,
                type: 'tool_call_chunk' as const,
            }));
            yield new ChatGenerationChunk({
                text: '',
                message: new AIMessageChunk({ content: '', tool_call_chunks: toolCallChunks }),
            });
        }

        // 3) 兜底：保证至少一个分片（见上方注释）
        if (!yielded) {
            yield new ChatGenerationChunk({
                text: '',
                message: new AIMessageChunk({ content: '' }),
            });
        }
    }

    /** 从脚本队列弹出一条响应；用尽即抛 —— 常见于测试"以为只调一次"却多调了一次。 */
    private shiftMessage(): AIMessage {
        const next = this.queue.shift();
        if (next === undefined) {
            throw new Error('FakeChatModel: 脚本响应已用尽');
        }
        return typeof next === 'string' ? new AIMessage(next) : next;
    }
}
