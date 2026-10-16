'use client';

/**
 * 聊天主组件（客户端边界）：
 * - 布局：左侧会话侧栏（Apple 源列表风格）+ 右侧对话区（glass 导航条）；
 * - 状态：消息 / threadId / 忙碌 / server 健康 / 输入草稿 / 会话列表与自定义标题；
 * - 会话：列表回读、切换、重命名（localStorage）、删除（服务端 + 本地）；
 * - 发送走 SSE 流式；生成中可直接发送（打断旧流）；支持停止 / 撤回 / 重新生成 / 导出。
 *
 * 设计语言：Apple —— 浅灰底 #f5f5f7、蓝色仅用于交互、白色卡片气泡、
 * 毛玻璃 chrome（backdrop-blur + saturate）、大量留白与细腻分割线
 * （见 src/app/globals.css 的设计令牌）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Composer } from '@/components/composer';
import { MessageBubble } from '@/components/message-bubble';
import { Sidebar } from '@/components/sidebar';
import {
    type ChatMessage,
    deleteThread,
    fetchHealth,
    fetchHistory,
    fetchThreads,
    newThreadId,
    rewindThread,
    streamChat,
    type ThreadSummary,
} from '@/lib/api';
import { downloadMarkdown, threadToMarkdown } from '@/lib/export';
import { formatFullTokens, formatTokens } from '@/lib/format';

/** localStorage 键带版本号：将来格式变更时可安全迁移/丢弃旧值。 */
const THREAD_STORAGE_KEY = 'social-proxy-agent:thread-id:v1';
const TITLES_STORAGE_KEY = 'social-proxy-agent:thread-titles:v1';

const EXAMPLES = ['帮我算 1+2*3 等于几', '现在几点了（Asia/Shanghai）', '用 50 字讲个科幻小故事'];

export function Chat() {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [threadId, setThreadId] = useState('');
    const [busy, setBusy] = useState(false);
    const [serverUp, setServerUp] = useState<boolean | null>(null); // null = 尚未探测
    /** 外部注入输入框的草稿（撤回时把问题填回）；nonce 变化即应用。 */
    const [draft, setDraft] = useState<{ text: string; nonce: number } | null>(null);
    const [threads, setThreads] = useState<ThreadSummary[]>([]);
    /** 自定义会话标题（本地存储；未命名则用首条消息预览）。 */
    const [titles, setTitles] = useState<Record<string, string>>({});
    const abortRef = useRef<AbortController | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    /** 历史回读竞态守卫：快速切换会话时忽略过期响应。 */
    const loadSeqRef = useRef(0);

    const refreshThreads = useCallback(async () => {
        const list = await fetchThreads();
        if (list !== null) {
            setThreads(list);
        }
    }, []);

    // 挂载：恢复标题 / 会话 + 回读历史 + 探测 server + 拉会话列表
    useEffect(() => {
        let ignore = false;
        try {
            const storedTitles = window.localStorage.getItem(TITLES_STORAGE_KEY);
            if (storedTitles !== null) {
                setTitles(JSON.parse(storedTitles) as Record<string, string>);
            }
        } catch {
            // 坏数据忽略，用空标题
        }
        const stored = window.localStorage.getItem(THREAD_STORAGE_KEY);
        if (stored !== null && stored.length > 0) {
            setThreadId(stored);
            const seq = ++loadSeqRef.current;
            void fetchHistory(stored).then((history) => {
                if (
                    !ignore &&
                    loadSeqRef.current === seq &&
                    history !== null &&
                    history.length > 0
                ) {
                    setMessages(history);
                }
            });
        }
        void fetchHealth().then((up) => {
            if (!ignore) {
                setServerUp(up);
            }
        });
        void refreshThreads();
        return () => {
            ignore = true;
        };
    }, [refreshThreads]);

    // 新内容到达时平滑滚到底部。
    // messages 是「触发信号」而非 effect 体内直接读取的值 —— 对这类
    // signal-dependency 用法，lint 的“多余依赖”判断是误报，显式忽略。
    // biome-ignore lint/correctness/useExhaustiveDependencies: 以 messages 变化为滚动触发信号
    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }, [messages]);

    // Esc：生成中按下 = 立即停止（与「停止」按钮等价）
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                abortRef.current?.abort();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, []);

    /**
     * 按消息 id 更新本轮助手消息。
     * 为什么不用「更新最后一条」？—— 打断后立刻发新消息时，旧流的回调
     * 会晚于新消息到达；按 id 更新才能保证旧回调只作用于自己那条。
     */
    function updateAssistant(id: string, updater: (message: ChatMessage) => ChatMessage) {
        setMessages((prev) => prev.map((m) => (m.id === id ? updater(m) : m)));
    }

    async function handleSend(text: string) {
        // 生成中发送 = 打断当前生成：旧流收到 abort 后自行按 id 收尾
        abortRef.current?.abort();

        // 首个消息：生成并持久化 threadId；后续消息沿用（多轮上下文由服务端 checkpointer 维护）
        const activeThread = threadId.length > 0 ? threadId : newThreadId();
        if (threadId.length === 0) {
            setThreadId(activeThread);
            window.localStorage.setItem(THREAD_STORAGE_KEY, activeThread);
        }

        const assistantId = crypto.randomUUID();
        setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: 'user' as const, content: text },
            { id: assistantId, role: 'assistant' as const, content: '', streaming: true },
        ]);
        setBusy(true);
        const controller = new AbortController();
        abortRef.current = controller;

        try {
            await streamChat(
                { message: text, threadId: activeThread, signal: controller.signal },
                {
                    onDelta: (delta) => {
                        updateAssistant(assistantId, (message) => ({
                            ...message,
                            content: message.content + delta,
                        }));
                    },
                    onReasoning: (delta) => {
                        // 思考过程单独累积（浅色过程样式展示，不混入正文）
                        updateAssistant(assistantId, (message) => ({
                            ...message,
                            reasoning: (message.reasoning ?? '') + delta,
                        }));
                    },
                    onChart: (spec) => {
                        // render_chart 产出：追加到本轮消息，气泡上方以图表卡渲染
                        updateAssistant(assistantId, (message) => ({
                            ...message,
                            charts: [...(message.charts ?? []), spec],
                        }));
                    },
                    onUsage: (usage) => {
                        // 本轮 token 用量（收尾帧）：显示在气泡底部
                        updateAssistant(assistantId, (message) => ({ ...message, usage }));
                    },
                    onToolStart: ({ calls, thought }) => {
                        // 新一轮工具调用：追加执行中的卡片（result 空即显示 spinner）
                        updateAssistant(assistantId, (message) => ({
                            ...message,
                            toolEvents: [
                                ...(message.toolEvents ?? []),
                                ...calls.map((call) => ({
                                    name: call.name,
                                    args: call.args,
                                    ...(thought !== undefined ? { thought } : {}),
                                })),
                            ],
                        }));
                    },
                    onToolEnd: ({ results }) => {
                        // 按 name 填充最近一个未完成的同名工具卡（并发同名极少见）
                        updateAssistant(assistantId, (message) => {
                            const events = message.toolEvents ?? [];
                            for (const result of results) {
                                const index = events.findLastIndex(
                                    (event) =>
                                        event.name === result.name && event.result === undefined,
                                );
                                if (index >= 0) {
                                    events[index] = { ...events[index], result: result.result };
                                }
                            }
                            return { ...message, toolEvents: [...events] };
                        });
                    },
                    onDone: () => {
                        updateAssistant(assistantId, (message) => ({
                            ...message,
                            streaming: false,
                        }));
                    },
                    onError: (error) => {
                        updateAssistant(assistantId, (message) => ({
                            ...message,
                            streaming: false,
                            error: true,
                            content: `出错了：${error.message}（${error.code}）`,
                        }));
                        // 能收到响应说明 server 在线，是个体请求失败
                        setServerUp(true);
                    },
                },
            );
        } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') {
                // 用户点了停止或发新消息打断：保留已生成的内容
                updateAssistant(assistantId, (message) => ({ ...message, streaming: false }));
            } else {
                // 网络层失败：server 没起 / 跨域被拒
                setServerUp(false);
                updateAssistant(assistantId, (message) => ({
                    ...message,
                    streaming: false,
                    error: true,
                    content: '连接不上 server —— 请确认已启动 pnpm dev:server',
                }));
            }
        } finally {
            // 只有「当前请求」才负责复位 busy —— 被替换的旧请求的 finally
            // 不能踩新请求的状态（否则新消息发出后 busy 立刻被清掉）
            if (abortRef.current === controller) {
                setBusy(false);
                abortRef.current = null;
            }
            // 会话列表刷新（新会话首次发送后出现在侧栏；预览/时间也随之更新）
            void refreshThreads();
        }
    }

    function handleStop() {
        abortRef.current?.abort();
    }

    /** 撤回最后一轮问答：服务端删除，本地截断，问题填回输入框供修改重发。 */
    async function handleRewind() {
        if (busy || threadId.length === 0) {
            return;
        }
        const lastUserIndex = messages.findLastIndex((message) => message.role === 'user');
        const target = lastUserIndex >= 0 ? messages[lastUserIndex] : undefined;
        if (target === undefined) {
            return;
        }
        const ok = await rewindThread(threadId);
        if (!ok) {
            return; // 服务端失败：本地不动，避免两边状态不一致
        }
        setMessages((prev) => prev.slice(0, lastUserIndex));
        setDraft({ text: target.content, nonce: Date.now() });
        void refreshThreads();
    }

    /** 重新生成：撤回最后一轮后立即用原文重发（等价「撤回 + 发送」一键版）。 */
    async function handleRegenerate() {
        if (busy || threadId.length === 0) {
            return;
        }
        const lastUserIndex = messages.findLastIndex((message) => message.role === 'user');
        const target = lastUserIndex >= 0 ? messages[lastUserIndex] : undefined;
        if (target === undefined) {
            return;
        }
        const ok = await rewindThread(threadId);
        if (!ok) {
            return;
        }
        setMessages((prev) => prev.slice(0, lastUserIndex));
        void handleSend(target.content);
    }

    /** 切换会话：打断旧流 → 清空并回读目标会话历史。 */
    async function handleSelectThread(id: string) {
        if (id === threadId) {
            return;
        }
        abortRef.current?.abort();
        setThreadId(id);
        window.localStorage.setItem(THREAD_STORAGE_KEY, id);
        setMessages([]);
        setDraft(null);
        const seq = ++loadSeqRef.current;
        const history = await fetchHistory(id);
        if (loadSeqRef.current === seq) {
            setMessages(history ?? []);
        }
    }

    /** 删除会话：服务端删除 + 本地清理（当前会话被删则回到空态）。 */
    async function handleDeleteThread(id: string) {
        if (!window.confirm('删除该会话？服务端记录将一并清除，不可恢复。')) {
            return;
        }
        const ok = await deleteThread(id);
        if (!ok) {
            return;
        }
        setTitles((prev) => {
            const next = { ...prev };
            delete next[id];
            try {
                window.localStorage.setItem(TITLES_STORAGE_KEY, JSON.stringify(next));
            } catch {
                // 存储失败忽略（内存态仍生效）
            }
            return next;
        });
        if (id === threadId) {
            abortRef.current?.abort();
            setThreadId('');
            setMessages([]);
            setDraft(null);
            window.localStorage.removeItem(THREAD_STORAGE_KEY);
        }
        void refreshThreads();
    }

    /** 重命名（本地存储）：空标题 = 恢复预览显示。 */
    function handleRename(id: string, title: string) {
        setTitles((prev) => {
            const next = { ...prev };
            const trimmed = title.trim();
            if (trimmed.length === 0) {
                delete next[id];
            } else {
                next[id] = trimmed;
            }
            try {
                window.localStorage.setItem(TITLES_STORAGE_KEY, JSON.stringify(next));
            } catch {
                // 存储失败忽略
            }
            return next;
        });
    }

    /** 导出当前会话为 Markdown 文件。 */
    function handleExport() {
        if (messages.length === 0) {
            return;
        }
        const stamp = new Date()
            .toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })
            .slice(0, 16)
            .replaceAll(':', '-')
            .replace(' ', '_');
        const name = `sp-agent_${threadId.length > 0 ? threadId : 'session'}_${stamp}.md`;
        downloadMarkdown(name, threadToMarkdown(threadId, messages));
    }

    function handleNewConversation() {
        abortRef.current?.abort();
        setMessages([]);
        setThreadId('');
        setDraft(null);
        window.localStorage.removeItem(THREAD_STORAGE_KEY);
        void refreshThreads();
    }

    // 「撤回」挂最新一条用户消息；「重新生成」挂最新一条助手消息（服务端都只支持最后一轮）
    const lastUserIndex = messages.findLastIndex((message) => message.role === 'user');
    const currentTitle =
        titles[threadId] ??
        threads.find((thread) => thread.threadId === threadId)?.preview ??
        (threadId.length > 0 ? threadId : '新会话');
    /** 本会话累计 token（各轮 usage 求和，展示在 header）。 */
    const totalTokens = messages.reduce(
        (sum, message) => sum + (message.usage?.totalTokens ?? 0),
        0,
    );

    return (
        <div className="flex h-full w-full overflow-hidden">
            <Sidebar
                serverUp={serverUp}
                threads={threads}
                activeId={threadId}
                titles={titles}
                onSelect={handleSelectThread}
                onNew={handleNewConversation}
                onRename={handleRename}
                onDelete={handleDeleteThread}
            />

            <div className="flex min-w-0 flex-1 flex-col">
                <header className="sticky top-0 z-10 border-b border-hairline bg-white/70 backdrop-blur-xl backdrop-saturate-150">
                    <div className="flex h-12 w-full items-center justify-between gap-3 px-4 md:px-6">
                        <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-[13px] font-semibold tracking-tight">
                                {currentTitle}
                            </span>
                            {threadId.length > 0 ? (
                                <span className="hidden font-mono text-[11px] text-ink-secondary lg:inline">
                                    {threadId}
                                </span>
                            ) : null}
                            {totalTokens > 0 ? (
                                <span
                                    title={`本会话累计 ${formatFullTokens(totalTokens)} tokens`}
                                    className="hidden shrink-0 text-[11px] text-ink-secondary sm:inline"
                                >
                                    Σ {formatTokens(totalTokens)} tokens
                                </span>
                            ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-3">
                            <button
                                type="button"
                                onClick={handleExport}
                                disabled={messages.length === 0}
                                title="导出当前会话为 Markdown"
                                className="text-[13px] text-accent transition hover:underline disabled:opacity-30 disabled:hover:no-underline"
                            >
                                导出
                            </button>
                            <button
                                type="button"
                                onClick={handleNewConversation}
                                className="text-[13px] text-accent transition hover:underline md:hidden"
                            >
                                新会话
                            </button>
                        </div>
                    </div>
                </header>

                <div ref={scrollRef} className="flex-1 overflow-y-auto">
                    <div
                        role="log"
                        aria-live="polite"
                        className="flex w-full flex-col gap-3 px-4 py-6 md:px-6"
                    >
                        {messages.length === 0 ? (
                            <EmptyState onPick={handleSend} />
                        ) : (
                            messages.map((message, index) => (
                                <MessageBubble
                                    key={message.id}
                                    message={message}
                                    canRewind={!busy && index === lastUserIndex}
                                    onRewind={handleRewind}
                                    canRegenerate={
                                        !busy &&
                                        index === messages.length - 1 &&
                                        message.role === 'assistant' &&
                                        message.streaming !== true &&
                                        message.error !== true
                                    }
                                    onRegenerate={handleRegenerate}
                                />
                            ))
                        )}
                    </div>
                </div>

                <div className="border-t border-hairline bg-white/60 backdrop-blur-xl">
                    <Composer busy={busy} onSend={handleSend} onStop={handleStop} preset={draft} />
                </div>
            </div>
        </div>
    );
}

/** 空态：Apple 产品页式标题 + 示例问题（点击直接发送）。 */
function EmptyState({ onPick }: { onPick: (text: string) => void }) {
    return (
        <div className="flex flex-col items-center gap-10 pt-28 text-center">
            <div>
                <h1 className="text-[44px] leading-[1.07] font-semibold tracking-[-0.02em]">
                    Social Proxy Agent
                </h1>
                <p className="mt-3 text-[17px] leading-[1.47] text-ink-secondary">
                    Koa 3 + LangGraph Agent · 工具调用与流式输出
                </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
                {EXAMPLES.map((example) => (
                    <button
                        key={example}
                        type="button"
                        onClick={() => onPick(example)}
                        className="rounded-full border border-hairline bg-surface-raised px-4 py-2 text-[13px] text-ink transition hover:border-accent hover:text-accent"
                    >
                        {example}
                    </button>
                ))}
            </div>
        </div>
    );
}
