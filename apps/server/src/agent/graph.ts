/**
 * Agent 核心：用 LangGraph 的 StateGraph 手写一个 ReAct Agent 图。
 *
 * 先把 LangGraph 的四个概念映射到本文件：
 * - **状态（State）**：一份跟着对话走的数据。这里用 `MessagesAnnotation`，
 *   其内置 reducer 会把每个节点返回的新消息「追加」进 messages 数组；
 * - **节点（Node）**：`async (state, config) => 状态局部更新`。
 *   本项目有两个：model（调 LLM）与 tools（执行工具调用）；
 * - **边（Edge）**：决定流转。`START → model`、`tools → model`（回到模型）
 *   是普通边；`model → tools 或 END` 是**条件边**（按 toolsCondition 的返回值路由）；
 * - **checkpointer**：按 `thread_id` 把每步状态存快照 → 多轮会话与进程重启续聊。
 *
 * 整张图的执行循环（ReAct）：
 *
 *     START ──▶ model ──(模型要求调工具?)──▶ tools ──▶ model ──…──▶ END
 *                  │  （不再要工具时）
 *                  └──────────────────────▶ END
 *
 * 一次带工具的对话：模型返回 tool_calls → tools 节点逐个执行、把结果
 * 作为 ToolMessage 追加 → 模型带着工具结果再推理 → 给出最终文本 → 结束。
 *
 * 为什么不直接用 prebuilt 的 createReactAgent？—— 它在本版本（langgraph 1.5）
 * 已标记 deprecated（迁往 langchain 包）；`ToolNode` / `toolsCondition` 仍是
 * 官方维护的稳定原语，手写这只多出十几行，却零额外依赖、完全可控。
 */
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

/** 默认系统提示词：SP 运维助手 + 工具使用纪律（发信号的人工闸门写在提示词里）。 */
export const DEFAULT_SYSTEM_PROMPT = [
    '你是 sitin social-proxy（SP）运维助手，通过工具帮用户完成：下发信号、脚本错误分析、出报表、在线数据查询。',
    '行为准则：',
    '1. SP 与 SLS 工具都带 env 参数区分环境：dev（默认，测试环境）/ prod（线上环境）。用户未指明环境时用 dev；用户提到「线上 / 生产 / prod」时用 prod；不要把 dev 的数据当成线上结论——回答时说明数据来自哪个环境。',
    '2. 发送信号（sp_send_signal）必须分两步：先向用户复述「环境（dev/prod）+ type / creatorId / userId / payload」并征得明确同意，之后才可用 confirm=true（保持同一 env）再次调用；用户未明确同意时严禁 confirm=true；向线上（prod）下发必须在复述里显式提醒目标为线上。',
    '3. 时间范围未指定时默认最近 7 天；报表输出优先使用 Markdown 表格。',
    '4. 只引用工具返回的数据，不臆造数字；工具报错时如实转述，并给出可操作的下一步建议（如检查对应环境的 token、网络或参数）。',
    '5. 当分析结果适合可视化（时间趋势 / 类别对比 / 占比分布）时，调用 render_chart 生成图表：数据必须来自已有工具结果，不要臆造；正文结论可直接引用图表，不必重复输出全部数字。',
    '6. 排查问题前、或用户问「之前 / 上次 / 历史有没有相关经验」时，先用 kb_search 检索个人知识库（排错笔记 / 项目约定），基于检索结果回答并注明笔记路径；需要原文时用 kb_read。',
    '7. 回答使用简体中文。',
].join('\n');

export interface CreateAgentGraphOptions {
    /** 必传：任何 BaseChatModel 实现（生产 ChatOpenAI，测试 FakeChatModel）。 */
    model: BaseChatModel;
    /** 工具清单，默认空；生产由 index.ts 注入 SP 工具集。 */
    tools?: StructuredToolInterface[];
    /** 会话存储，默认进程内存；生产用 createCheckpointer() 传 SQLite。 */
    checkpointer?: BaseCheckpointSaver;
    /** 系统提示词；传空字符串可关闭注入（测试常用，便于断言纯消息序列）。 */
    systemPrompt?: string;
    /** 送模型的上下文 token 预算（粗略估算，见 trimHistory）；默认 48000。 */
    maxInputTokens?: number;
}

/** 上下文预算默认值：给输出与系统提示词留出余量的保守值。 */
export const DEFAULT_MAX_INPUT_TOKENS = 48_000;

/**
 * 粗略 token 估算：**区分 CJK 与其它字符**——中文≈1 token/字，英文≈1 token/4 字符。
 * 早前用「总长度 / 3」对中文为主的日志内容会低估约 3 倍（实测：估算 48k 预算下
 * 真实 input 已达 79k token），修正后按字符类别分别折算。
 * 只用于裁剪决策（宁保守勿溢出），不追求精确。
 */
function estimateTokens(text: string): number {
    const cjkCount = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g) ?? [])
        .length;
    const restCount = text.length - cjkCount;
    return cjkCount + Math.ceil(restCount / 4);
}

function estimateMessageTokens(message: BaseMessage): number {
    const toolCalls = message instanceof AIMessage ? (message.tool_calls ?? []) : [];
    const payload = message.text + (toolCalls.length > 0 ? JSON.stringify(toolCalls) : '');
    return estimateTokens(payload) + 10;
}

/**
 * 上下文裁剪：按 token 预算保留「最近的完整对话轮」。
 *
 * 为什么不简单删最旧的几条？
 * - 工具轮次里 AI(tool_calls) 与随后的 ToolMessage 是成对语义，拆开会让模型 API 报错；
 * - 所以从末尾往前累计预算，找出最早可保留的位置后，再**向前对齐到 human 消息**
 *   （一条人类消息 = 一轮对话的起点，从这里切分序列永远合法）。
 * - 兜底：单轮本身超预算（如一次拉了大日志）时，保留该整轮——
 *   宁可略超也不破坏序列；checkpointer 里的完整历史不受影响（只影响送模型的输入）。
 */
export function trimHistory(messages: BaseMessage[], maxTokens: number): BaseMessage[] {
    let budget = maxTokens;
    let start = messages.length;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message === undefined) {
            continue;
        }
        const cost = estimateMessageTokens(message);
        if (budget - cost < 0) {
            break;
        }
        budget -= cost;
        start = i;
    }

    // 向前对齐到 human 边界（跳过裁切造成的「半轮」：只有工具/AI 没有提问的残段）
    for (let i = start; i < messages.length; i += 1) {
        if (messages[i]?.getType() === 'human') {
            return messages.slice(i);
        }
    }

    // 预算内没有 human（单轮超长）：回退到最后一个 human，保整轮合法性
    for (let i = Math.min(start, messages.length - 1); i >= 0; i -= 1) {
        if (messages[i]?.getType() === 'human') {
            return messages.slice(i);
        }
    }
    return messages;
}

/**
 * 生成新的会话 ID：`t_` + 16 位十六进制（UUID 去掉连字符截断）。
 * 格式满足 config.ts 里的 THREAD_ID_PATTERN（路由校验同一规则）。
 */
export function newThreadId(): string {
    return `t_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

/**
 * 从消息列表里取「最后一条有文本的 AI 消息」——即最终回复。
 * 为什么不能直接取最后一条？因为工具轮次中的 AIMessage 只有 tool_calls、
 * 文本可能为空；要跳过这些、也跳过 ToolMessage，找到真正说给人听的那句。
 *
 * 注意用 `message.text` 而不是 `message.content`：流式（stream-events 协议）
 * 路径下 content 可能是 content-blocks 数组（reasoning/text 混合），
 * `.text` 会跳过 reasoning 只取文本块；字符串 content 同样适用。
 */
export function lastAiReply(messages: BaseMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message !== undefined && message instanceof AIMessage) {
            const text = message.text;
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
        tools = [],
        checkpointer = new MemorySaver(),
        systemPrompt = DEFAULT_SYSTEM_PROMPT,
        maxInputTokens = DEFAULT_MAX_INPUT_TOKENS,
    } = options;

    // bindTools 的作用：把工具的 schema 告知模型（Function Calling 的定义部分）。
    // 返回的是包装后的 Runnable；不支持工具能力的模型退化为原模型（? 兼容处理）。
    const boundModel = model.bindTools?.(tools) ?? model;

    /**
     * model 节点：读 state.messages → 调模型 → 把回复追加进状态。
     * 注意 system prompt 的注入方式：每次调用「临时拼接」而非写入 state ——
     * 这样它不会进 checkpointer 的历史（不占 token、不污染 /threads 返回的消息列表）。
     * 送模型前按预算裁剪历史（trimHistory）：长会话不会撑爆上下文；
     * checkpointer 里仍保存完整历史，裁剪只影响「这次模型看到什么」。
     */
    const callModel = async (state: typeof MessagesAnnotation.State, config?: RunnableConfig) => {
        const history = trimHistory(state.messages, maxInputTokens);
        const messages =
            systemPrompt.length > 0 ? [new SystemMessage(systemPrompt), ...history] : history;
        // config 必须透传：流式回调（TokenStreamHandler）依赖它把回调挂进这次模型调用
        const response = await boundModel.invoke(messages, config);
        return { messages: [response] };
    };

    return (
        new StateGraph(MessagesAnnotation)
            .addNode('model', callModel)
            // ToolNode 是内置原语：自动从最后一条 AIMessage 里读 tool_calls、
            // 按名字找到工具执行、把每个结果包成 ToolMessage 返回
            .addNode('tools', new ToolNode(tools))
            .addEdge(START, 'model')
            // 条件边：toolsCondition 检查最后一条 AIMessage——
            // 有 tool_calls → 去 'tools'；否则 → END（对话结束，等用户下一轮输入）
            .addConditionalEdges('model', toolsCondition, ['tools', END])
            .addEdge('tools', 'model') // 工具执行完必须回到模型继续推理
            .compile({ checkpointer })
    );
}
