/**
 * Token 用量统计：从 AI 消息的 `usage_metadata` 累计（一次对话轮可能调多次模型 —— 工具轮）。
 *
 * 数据来源：@langchain/openai 对每次模型调用都会把 provider 返回的 usage
 * 写进 AIMessage.usage_metadata（流式与同步路径都会持久化到 checkpoint，已实测）。
 * 消费方：
 * - 流式路由：从 model 节点更新累计 → `usage` SSE 帧（前端展示每条回答的消耗）；
 * - 同步路由：invoke 前后全量 diff（结果里带全历史，不能直接加总）；
 * - 历史回读（toHistory）：按轮累计挂到助手消息上（刷新不丢）。
 */
import { AIMessage, type BaseMessage } from '@langchain/core/messages';

/** 一轮对话的 token 消耗（跨工具轮累加）。 */
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
}

/** 累计一组消息里 AI 消息的 usage_metadata（缺失 usage 的消息忽略）。 */
export function sumUsage(messages: BaseMessage[]): TokenUsage {
    let input = 0;
    let output = 0;
    let total = 0;
    for (const message of messages) {
        if (!(message instanceof AIMessage)) {
            continue;
        }
        const usage = message.usage_metadata;
        if (usage === undefined) {
            continue;
        }
        input += usage.input_tokens ?? 0;
        output += usage.output_tokens ?? 0;
        total += usage.total_tokens ?? 0;
    }
    return { inputTokens: input, outputTokens: output, totalTokens: total };
}

/** 两轮用量相加。 */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
    return {
        inputTokens: a.inputTokens + b.inputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        totalTokens: a.totalTokens + b.totalTokens,
    };
}

/** 是否有有效用量（全 0 视为无，如 FakeChatModel 场景）。 */
export function hasUsage(usage: TokenUsage): boolean {
    return usage.totalTokens > 0;
}
