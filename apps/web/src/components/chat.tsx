'use client';

/**
 * 聊天主组件（客户端边界）：
 * - 状态：消息列表 / threadId / 流式忙碌 / server 健康；
 * - 挂载时从 localStorage 恢复上次会话并回读历史（GET /agent/threads/:id）；
 * - 发送走 SSE 流式：delta 实时追加到「最后一条助手消息」，done/错误收尾；
 * - 支持中途停止（AbortController）。
 *
 * 设计语言：Apple 风格 —— 浅灰底 #f5f5f7、蓝色仅用于交互、白色卡片气泡、
 * 少量柔和阴影（见 src/app/globals.css 的设计令牌）。
 */
import { useEffect, useRef, useState } from 'react';
import { Composer } from '@/components/composer';
import { MessageBubble } from '@/components/message-bubble';
import { type ChatMessage, fetchHealth, fetchHistory, newThreadId, streamChat } from '@/lib/api';

/** localStorage 键带版本号：将来格式变更时可安全迁移/丢弃旧值。 */
const THREAD_STORAGE_KEY = 'social-proxy-agent:thread-id:v1';

const EXAMPLES = ['帮我算 1+2*3 等于几', '现在几点了（Asia/Shanghai）', '用 50 字讲个科幻小故事'];

export function Chat() {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [threadId, setThreadId] = useState('');
    const [busy, setBusy] = useState(false);
    const [serverUp, setServerUp] = useState<boolean | null>(null); // null = 尚未探测
    const abortRef = useRef<AbortController | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);

    // 挂载：恢复上次会话 + 回读历史 + 探测 server 健康
    useEffect(() => {
        let ignore = false;
        const stored = window.localStorage.getItem(THREAD_STORAGE_KEY);
        if (stored !== null && stored.length > 0) {
            setThreadId(stored);
            void fetchHistory(stored).then((history) => {
                if (!ignore && history !== null && history.length > 0) {
                    setMessages(history);
                }
            });
        }
        void fetchHealth().then((up) => {
            if (!ignore) {
                setServerUp(up);
            }
        });
        return () => {
            ignore = true;
        };
    }, []);

    // 新内容到达时平滑滚到底部。
    // messages 是「触发信号」而非 effect 体内直接读取的值 —— 对这类
    // signal-dependency 用法，lint 的“多余依赖”判断是误报，显式忽略。
    // biome-ignore lint/correctness/useExhaustiveDependencies: 以 messages 变化为滚动触发信号
    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }, [messages]);

    /** 函数式更新「最后一条助手消息」——流式追加/收尾都走这里。 */
    function updateLastAssistant(updater: (message: ChatMessage) => ChatMessage) {
        setMessages((prev) => {
            const last = prev.at(-1);
            if (last === undefined || last.role !== 'assistant') {
                return prev;
            }
            return [...prev.slice(0, -1), updater(last)];
        });
    }

    async function handleSend(text: string) {
        if (busy) {
            return;
        }
        // 首个消息：生成并持久化 threadId；后续消息沿用（多轮上下文由服务端 checkpointer 维护）
        const activeThread = threadId.length > 0 ? threadId : newThreadId();
        if (threadId.length === 0) {
            setThreadId(activeThread);
            window.localStorage.setItem(THREAD_STORAGE_KEY, activeThread);
        }

        setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: 'user', content: text },
            { id: crypto.randomUUID(), role: 'assistant', content: '', streaming: true },
        ]);
        setBusy(true);
        const controller = new AbortController();
        abortRef.current = controller;

        try {
            await streamChat(
                { message: text, threadId: activeThread, signal: controller.signal },
                {
                    onDelta: (delta) => {
                        updateLastAssistant((message) => ({
                            ...message,
                            content: message.content + delta,
                        }));
                    },
                    onDone: () => {
                        updateLastAssistant((message) => ({ ...message, streaming: false }));
                    },
                    onError: (error) => {
                        updateLastAssistant((message) => ({
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
                // 用户点了停止：保留已生成的内容
                updateLastAssistant((message) => ({ ...message, streaming: false }));
            } else {
                // 网络层失败：server 没起 / 跨域被拒
                setServerUp(false);
                updateLastAssistant((message) => ({
                    ...message,
                    streaming: false,
                    error: true,
                    content: '连接不上 server —— 请确认已启动 pnpm dev:server',
                }));
            }
        } finally {
            setBusy(false);
            abortRef.current = null;
        }
    }

    function handleStop() {
        abortRef.current?.abort();
    }

    function handleNewConversation() {
        abortRef.current?.abort();
        setMessages([]);
        setThreadId('');
        window.localStorage.removeItem(THREAD_STORAGE_KEY);
    }

    return (
        <>
            <header className="sticky top-0 z-10 border-b border-hairline bg-white/70 backdrop-blur-xl">
                <div className="mx-auto flex h-12 w-full max-w-[720px] items-center justify-between px-4">
                    <div className="flex items-center gap-2">
                        <StatusDot up={serverUp} />
                        <span className="text-[13px] font-semibold tracking-tight">
                            Social Proxy Agent
                        </span>
                    </div>
                    <div className="flex items-center gap-3">
                        {threadId.length > 0 ? (
                            <span className="hidden font-mono text-[11px] text-ink-secondary sm:inline">
                                {threadId}
                            </span>
                        ) : null}
                        <button
                            type="button"
                            onClick={handleNewConversation}
                            className="text-[13px] text-accent transition hover:underline"
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
                    className="mx-auto flex w-full max-w-[720px] flex-col gap-3 px-4 py-6"
                >
                    {messages.length === 0 ? (
                        <EmptyState onPick={handleSend} />
                    ) : (
                        messages.map((message) => (
                            <MessageBubble key={message.id} message={message} />
                        ))
                    )}
                </div>
            </div>

            <div className="border-t border-hairline bg-surface/80 backdrop-blur-xl">
                <Composer busy={busy} onSend={handleSend} onStop={handleStop} />
            </div>
        </>
    );
}

/** server 连接状态圆点（绿=在线 / 红=不可用 / 灰=未探测）。 */
function StatusDot({ up }: { up: boolean | null }) {
    if (up === null) {
        return <span title="连接状态未知" className="size-2 rounded-full bg-ink-secondary/40" />;
    }
    return (
        <span
            title={up ? 'server 已连接' : 'server 不可用'}
            className={`size-2 rounded-full ${up ? 'bg-[#34c759]' : 'bg-[#ff3b30]'}`}
        />
    );
}

/** 空态：产品标题 + 示例问题（点击直接发送）。 */
function EmptyState({ onPick }: { onPick: (text: string) => void }) {
    return (
        <div className="flex flex-col items-center gap-8 pt-24 text-center">
            <div>
                <h1 className="text-[40px] leading-[1.1] font-semibold tracking-[-0.28px]">
                    Social Proxy Agent
                </h1>
                <p className="mt-2 text-[15px] text-ink-secondary">
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
