import { randomUUID } from 'node:crypto';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage, SystemMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { StructuredToolInterface } from '@langchain/core/tools';
import {
    type BaseCheckpointSaver,
    END,
    MemorySaver,
    MessagesAnnotation,
    START,
    StateGraph,
} from '@langchain/langgraph';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import { agentTools } from './tools.js';

export const DEFAULT_SYSTEM_PROMPT =
    '你是一个乐于助人的 AI 助手。需要计算或查询时间时请调用提供的工具。回答使用简体中文。';

export interface CreateAgentGraphOptions {
    model: BaseChatModel;
    tools?: StructuredToolInterface[];
    checkpointer?: BaseCheckpointSaver;
    systemPrompt?: string;
}

export function newThreadId(): string {
    return `t_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

export function lastAiReply(messages: BaseMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message !== undefined && message instanceof AIMessage) {
            const text = typeof message.content === 'string' ? message.content : '';
            if (text.length > 0) {
                return text;
            }
        }
    }
    return '';
}

export function createAgentGraph(options: CreateAgentGraphOptions) {
    const {
        model,
        tools = agentTools,
        checkpointer = new MemorySaver(),
        systemPrompt = DEFAULT_SYSTEM_PROMPT,
    } = options;

    const boundModel = model.bindTools?.(tools) ?? model;

    const callModel = async (state: typeof MessagesAnnotation.State, config?: RunnableConfig) => {
        const messages =
            systemPrompt.length > 0
                ? [new SystemMessage(systemPrompt), ...state.messages]
                : state.messages;
        const response = await boundModel.invoke(messages, config);
        return { messages: [response] };
    };

    return new StateGraph(MessagesAnnotation)
        .addNode('model', callModel)
        .addNode('tools', new ToolNode(tools))
        .addEdge(START, 'model')
        .addConditionalEdges('model', toolsCondition, ['tools', END])
        .addEdge('tools', 'model')
        .compile({ checkpointer });
}
