/**
 * 逐 token 流式的核心回调。
 *
 * ## 为什么需要这个类？
 * 本项目实测（langgraph 1.5 / core 1.2）发现：图的经典 `streamMode:"messages"`
 * 对自定义模型只会回**聚合后的最终消息**（一条完整文本），拿不到逐 token 增量。
 * 想要真正 token 级流式，需要让模型走「stream-events 协议」：
 * 挂一个声明了 `lc_prefer_chat_model_stream_events = true` 的 callback handler，
 * LangChain core 就会把模型输出的分片以 `handleChatModelStreamEvent` 逐事件回调进来。
 *
 * ## 事件序列（一次模型调用）
 *     message-start               开始一条消息
 *     content-block-start         （文本块开始，可忽略）
 *     content-block-delta {delta:{type:'text-delta', text}}   ← 这就是 token 增量
 *     content-block-delta ...
 *     content-block-finish
 *     message-finish              一条消息结束
 *
 * ## 为什么维护 current / last 两个缓冲？
 * 一次图执行可能有多次模型调用（工具轮 + 最终回答轮）：
 * - `current`：当前这条消息累积的文本；
 * - `last`：**已完成**的上一条消息文本。
 * 工具轮里模型可能先说一句话（如「我先算一下」）再去调工具 —— 那是过程文本；
 * 最终要吐给用户的 `done.reply` 应该是最后一条已完结消息的全文，
 * 所以 `message-start` 重置 current、`message-finish` 把 current 提交给 last。
 * （逐 token 的 `onDelta` 回调则照常实时外发 —— 用户能看到全部生成过程。）
 */
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { ChatModelStreamEvent } from '@langchain/core/language_models/event';

export class TokenStreamHandler extends BaseCallbackHandler {
    override name = 'TokenStreamHandler';
    /** 声明偏好：core 看到它就走 stream-events 分支（见文件头注释） */
    lc_prefer_chat_model_stream_events = true;

    private current = '';
    private last = '';

    /** onDelta：每收到一个文本分片回调一次（路由里用它写 SSE message.delta）。 */
    constructor(private readonly onDelta: (text: string) => void) {
        super();
    }

    override handleChatModelStreamEvent(event: ChatModelStreamEvent, _runId: string): void {
        switch (event.event) {
            case 'message-start':
                this.current = ''; // 新消息开始，重置累积
                break;
            case 'content-block-delta':
                // 只关心文本增量；忽略 reasoning / tool_call 等其他块类型
                if (event.delta.type === 'text-delta' && event.delta.text.length > 0) {
                    this.current += event.delta.text;
                    this.onDelta(event.delta.text);
                }
                break;
            case 'message-finish':
                this.last = this.current; // 消息完结，提交为「最终答复候选」
                break;
            default:
                break;
        }
    }

    /** 最终回复：优先取上一条已完结消息；没有（如异常中断）则退回当前累积。 */
    get reply(): string {
        return this.last.length > 0 ? this.last : this.current;
    }
}
