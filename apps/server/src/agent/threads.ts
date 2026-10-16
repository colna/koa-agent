/**
 * 会话列表 / 删除：给「多会话管理」提供的存储层。
 *
 * 数据来源就是 checkpointer 自己的 SQLite 库（`checkpoints` 表），不另建索引：
 * - 列表：每个 thread 取「最新 checkpoint」，从序列化状态里提取
 *   首条用户消息（预览）、消息条数、最后活跃时间；
 * - 删除：直接复用 SqliteSaver.deleteThread（事务内清 checkpoints + writes）。
 *
 * 设计取舍：
 * - 只在 SQLite checkpointer 下提供完整能力；MemorySaver（测试/演示）列表为空、
 *   删除抛错——因为内存库跨不了连接，没有"列表"可言；
 * - 用 saver 自带的 db 连接（SqliteSaver 公开 `db` 字段），省一条独立连接；
 * - 列表限制 200 条、解析失败的单条静默跳过（损坏数据不影响整体）。
 */
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';

/** 会话摘要（侧栏列表项）。 */
export interface ThreadSummary {
    threadId: string;
    /** 首条用户消息（换行折叠、截断 60 字）。 */
    preview: string;
    /** 对话消息条数（human + 有文本的 ai，工具消息不计）。 */
    messageCount: number;
    /** 最后活跃时间（ISO 8601，取自 checkpoint 的 ts）。 */
    updatedAt: string;
}

export interface ThreadStore {
    list(): Promise<ThreadSummary[]>;
    remove(threadId: string): Promise<void>;
}

/** 序列化消息（LangGraph 的 lc constructor 格式）里我们关心的字段。 */
interface SerializedMessage {
    /** 形如 ["langchain_core","messages","HumanMessage"]。 */
    id?: unknown;
    kwargs?: { content?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/** 从 lc 序列化消息里取消息类型短名（HumanMessage / AIMessage / …）。 */
function messageTypeOf(serialized: unknown): string {
    if (!isRecord(serialized)) {
        return '';
    }
    const id = (serialized as SerializedMessage).id;
    return Array.isArray(id) && typeof id[2] === 'string' ? id[2] : '';
}

/** 取消息文本：兼容字符串 content 与 content-blocks 数组（跳过 reasoning 块）。 */
function messageTextOf(serialized: unknown): string {
    if (!isRecord(serialized)) {
        return '';
    }
    const content = (serialized as SerializedMessage).kwargs?.content;
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .filter(
                (block): block is { type: string; text: string } =>
                    isRecord(block) && block.type === 'text' && typeof block.text === 'string',
            )
            .map((block) => block.text)
            .join('');
    }
    return '';
}

/** 解析一个 checkpoint blob → 会话摘要；没有用户消息（或数据损坏）返回 null。 */
function summarizeCheckpoint(threadId: string, blob: Buffer | string): ThreadSummary | null {
    try {
        const raw = typeof blob === 'string' ? blob : blob.toString('utf8');
        const state = JSON.parse(raw) as {
            ts?: string;
            channel_values?: { messages?: unknown[] };
        };
        const messages = Array.isArray(state.channel_values?.messages)
            ? state.channel_values.messages
            : [];

        let preview = '';
        let messageCount = 0;
        for (const message of messages) {
            const type = messageTypeOf(message);
            const text = messageTextOf(message);
            if (type === 'HumanMessage') {
                if (preview.length === 0) {
                    preview = text;
                }
                messageCount += 1;
            } else if (type === 'AIMessage' && text.length > 0) {
                messageCount += 1;
            }
        }
        if (preview.length === 0) {
            return null;
        }

        return {
            threadId,
            preview: preview.replaceAll('\n', ' ').trim().slice(0, 60),
            messageCount,
            updatedAt: state.ts ?? new Date().toISOString(),
        };
    } catch {
        return null;
    }
}

export function createThreadStore(saver: BaseCheckpointSaver): ThreadStore {
    if (!(saver instanceof SqliteSaver)) {
        // MemorySaver：没有跨连接的存储可查；删除明确抛错让调用方感知
        return {
            list: async () => [],
            remove: async () => {
                throw new Error('当前 checkpointer 不支持删除会话（需要 SQLite 存储）');
            },
        };
    }

    const db = saver.db;
    return {
        async list() {
            const rows = db
                .prepare(
                    `SELECT c.thread_id AS threadId, c.checkpoint AS checkpoint
                     FROM checkpoints c
                     JOIN (
                         SELECT thread_id, MAX(checkpoint_id) AS max_id
                         FROM checkpoints
                         WHERE checkpoint_ns = ''
                         GROUP BY thread_id
                     ) m ON c.thread_id = m.thread_id AND c.checkpoint_id = m.max_id
                     WHERE c.checkpoint_ns = ''
                     ORDER BY c.checkpoint_id DESC
                     LIMIT 200`,
                )
                .all() as { threadId: string; checkpoint: Buffer | string }[];

            const summaries: ThreadSummary[] = [];
            for (const row of rows) {
                const summary = summarizeCheckpoint(row.threadId, row.checkpoint);
                if (summary !== null) {
                    summaries.push(summary);
                }
            }
            return summaries;
        },
        async remove(threadId: string) {
            await saver.deleteThread(threadId);
        },
    };
}
