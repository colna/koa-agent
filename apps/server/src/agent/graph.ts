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
    '1. 发送信号（sp_send_signal）必须分两步：先向用户复述 type / creatorId / userId / payload 并征得明确同意，之后才可用 confirm=true 再次调用；用户未明确同意时严禁 confirm=true。',
    '2. 时间范围未指定时默认最近 7 天；报表输出优先使用 Markdown 表格。',
    '3. 只引用工具返回的数据，不臆造数字；工具报错时如实转述，并给出可操作的下一步建议（如检查 SP_ADMIN_TOKEN、网络或参数）。',
    '4. 回答使用简体中文。',
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
 */
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
        tools = [],
        checkpointer = new MemorySaver(),
        systemPrompt = DEFAULT_SYSTEM_PROMPT,
    } = options;

    // bindTools 的作用：把工具的 schema 告知模型（Function Calling 的定义部分）。
    // 返回的是包装后的 Runnable；不支持工具能力的模型退化为原模型（? 兼容处理）。
    const boundModel = model.bindTools?.(tools) ?? model;

    /**
     * model 节点：读 state.messages → 调模型 → 把回复追加进状态。
     * 注意 system prompt 的注入方式：每次调用「临时拼接」而非写入 state ——
     * 这样它不会进 checkpointer 的历史（不占 token、不污染 /threads 返回的消息列表）。
     */
    const callModel = async (state: typeof MessagesAnnotation.State, config?: RunnableConfig) => {
        const messages =
            systemPrompt.length > 0
                ? [new SystemMessage(systemPrompt), ...state.messages]
                : state.messages;
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
