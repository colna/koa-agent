import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import {
    BaseChatModel,
    type BaseChatModelParams,
    type BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';

export type FakeChatResponse = AIMessage | string;

export interface FakeChatModelParams extends BaseChatModelParams {
    responses: FakeChatResponse[];
}

function textOf(message: AIMessage): string {
    return typeof message.content === 'string' ? message.content : '';
}

function splitIntoChunks(text: string, size = 4): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += size) {
        chunks.push(text.slice(i, i + size));
    }
    return chunks;
}

export class FakeChatModel extends BaseChatModel {
    private readonly queue: FakeChatResponse[];
    readonly calls: BaseMessage[][] = [];
    readonly boundTools: BindToolsInput[] = [];

    constructor(params: FakeChatModelParams) {
        super(params);
        this.queue = [...params.responses];
    }

    override _llmType(): string {
        return 'fake-chat-model';
    }

    override bindTools(tools: BindToolsInput[]): this {
        this.boundTools.length = 0;
        this.boundTools.push(...tools);
        return this;
    }

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

        for (const piece of splitIntoChunks(text)) {
            yielded = true;
            yield new ChatGenerationChunk({
                text: piece,
                message: new AIMessageChunk({ content: piece }),
            });
        }

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

        if (!yielded) {
            yield new ChatGenerationChunk({
                text: '',
                message: new AIMessageChunk({ content: '' }),
            });
        }
    }

    private shiftMessage(): AIMessage {
        const next = this.queue.shift();
        if (next === undefined) {
            throw new Error('FakeChatModel: 脚本响应已用尽');
        }
        return typeof next === 'string' ? new AIMessage(next) : next;
    }
}
