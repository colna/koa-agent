/**
 * 会话侧栏（Apple / macOS「源列表」风格）：
 * - 顶部：状态点 + 应用名；下方「新会话」主按钮（Apple Blue 胶囊）；
 * - 列表：最近会话（标题 / 相对时间 / 条数），当前会话以蓝色胶囊高亮，
 *   悬停出现「改名 / 删除」小操作；改名内联编辑（Enter 提交，Esc 取消）；
 * - 标题优先自定义名（localStorage，由 Chat 管理），否则用首条消息预览；
 * - 窄屏隐藏（md 以下），由 header 的「新会话」按钮兜底。
 */
import { useEffect, useRef, useState } from 'react';
import type { ThreadSummary } from '@/lib/api';

export interface SidebarProps {
    serverUp: boolean | null;
    threads: ThreadSummary[];
    activeId: string;
    titles: Record<string, string>;
    onSelect: (threadId: string) => void;
    onNew: () => void;
    onRename: (threadId: string, title: string) => void;
    onDelete: (threadId: string) => void;
}

export function Sidebar({
    serverUp,
    threads,
    activeId,
    titles,
    onSelect,
    onNew,
    onRename,
    onDelete,
}: SidebarProps) {
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editingValue, setEditingValue] = useState('');
    const inputRef = useRef<HTMLInputElement | null>(null);
    /** Esc 取消时置位：避免随后的 blur 把「取消」变成「提交」。 */
    const skipBlurCommitRef = useRef(false);

    useEffect(() => {
        if (editingId !== null) {
            inputRef.current?.select();
        }
    }, [editingId]);

    function startEdit(thread: ThreadSummary) {
        setEditingId(thread.threadId);
        setEditingValue(titles[thread.threadId] ?? thread.preview);
    }

    function commitEdit() {
        if (editingId !== null) {
            onRename(editingId, editingValue);
        }
        setEditingId(null);
    }

    return (
        <aside className="hidden h-full w-[264px] shrink-0 flex-col border-r border-hairline bg-white/55 backdrop-blur-2xl md:flex">
            <div className="flex items-center gap-2 px-4 pt-4 pb-2">
                <StatusDot up={serverUp} />
                <span className="text-[13px] font-semibold tracking-tight">Social Proxy Agent</span>
            </div>

            <div className="px-3 pt-1 pb-2">
                <button
                    type="button"
                    onClick={onNew}
                    className="flex w-full items-center justify-center gap-1.5 rounded-full bg-accent px-3 py-2 text-[13px] font-medium text-white transition hover:bg-accent-hover"
                >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                        <path
                            d="M6 1.5v9M1.5 6h9"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                        />
                    </svg>
                    新会话
                </button>
            </div>

            <nav className="flex-1 overflow-y-auto px-2 pb-4">
                {threads.length === 0 ? (
                    <p className="px-3 py-8 text-center text-[12px] leading-[1.5] text-ink-secondary">
                        还没有历史会话
                        <br />
                        发送第一条消息后会出现在这里
                    </p>
                ) : (
                    <>
                        <p className="px-3 pt-2 pb-1.5 text-[11px] font-medium tracking-[0.02em] text-ink-secondary">
                            最近会话
                        </p>
                        <ul className="space-y-0.5">
                            {threads.map((thread) => {
                                const active = thread.threadId === activeId;
                                const title = titles[thread.threadId] ?? thread.preview;
                                return (
                                    <li key={thread.threadId}>
                                        {/* 卡片内含「改名 / 删除」子按钮与编辑输入框，无法用原生 button（嵌套交互元素非法）；键盘可达性由 tabIndex + onKeyDown 补齐 */}
                                        {/* biome-ignore lint/a11y/useSemanticElements: 见上注释 */}
                                        <div
                                            role="button"
                                            tabIndex={0}
                                            onMouseDown={(event) => {
                                                // 鼠标点击不夺焦：避免点过的条目一直亮着操作按钮
                                                // （键盘用户仍可通过 Tab 聚焦并触发 focus-within）
                                                if (editingId === null) {
                                                    event.preventDefault();
                                                }
                                            }}
                                            onClick={() => {
                                                if (editingId === null) {
                                                    onSelect(thread.threadId);
                                                }
                                            }}
                                            onKeyDown={(event) => {
                                                if (event.key === 'Enter' && editingId === null) {
                                                    onSelect(thread.threadId);
                                                }
                                            }}
                                            className={`group/item relative flex w-full cursor-pointer flex-col rounded-[10px] px-3 py-2 text-left transition ${
                                                active
                                                    ? 'bg-accent text-white'
                                                    : 'text-ink hover:bg-black/[0.045]'
                                            }`}
                                        >
                                            {editingId === thread.threadId ? (
                                                <input
                                                    ref={inputRef}
                                                    value={editingValue}
                                                    onChange={(event) =>
                                                        setEditingValue(event.target.value)
                                                    }
                                                    onBlur={() => {
                                                        if (skipBlurCommitRef.current) {
                                                            skipBlurCommitRef.current = false;
                                                            return;
                                                        }
                                                        commitEdit();
                                                    }}
                                                    onKeyDown={(event) => {
                                                        if (event.key === 'Enter') {
                                                            commitEdit();
                                                        } else if (event.key === 'Escape') {
                                                            skipBlurCommitRef.current = true;
                                                            setEditingId(null);
                                                        }
                                                    }}
                                                    className="w-full rounded-[6px] border border-accent/40 bg-white px-1.5 py-0.5 text-[13px] text-ink outline-none"
                                                />
                                            ) : (
                                                <>
                                                    <span className="truncate text-[13px] leading-[1.35] font-medium">
                                                        {title}
                                                    </span>
                                                    <span
                                                        className={`mt-0.5 flex items-center justify-between gap-2 text-[11px] leading-none ${
                                                            active
                                                                ? 'text-white/75'
                                                                : 'text-ink-secondary'
                                                        }`}
                                                    >
                                                        <span className="truncate">
                                                            {formatWhen(thread.updatedAt)} ·{' '}
                                                            {thread.messageCount} 条
                                                        </span>
                                                        <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover/item:opacity-100 group-focus-within/item:opacity-100">
                                                            <button
                                                                type="button"
                                                                title="重命名"
                                                                onClick={(event) => {
                                                                    event.stopPropagation();
                                                                    startEdit(thread);
                                                                }}
                                                                className={`rounded-full px-1.5 py-0.5 text-[11px] leading-none transition ${
                                                                    active
                                                                        ? 'text-white/80 hover:bg-white/20 hover:text-white'
                                                                        : 'text-ink-secondary hover:bg-black/[0.06] hover:text-ink'
                                                                }`}
                                                            >
                                                                改名
                                                            </button>
                                                            <button
                                                                type="button"
                                                                title="删除会话（连同服务端记录）"
                                                                onClick={(event) => {
                                                                    event.stopPropagation();
                                                                    onDelete(thread.threadId);
                                                                }}
                                                                className={`rounded-full px-1.5 py-0.5 text-[11px] leading-none transition ${
                                                                    active
                                                                        ? 'text-white/80 hover:bg-white/20 hover:text-white'
                                                                        : 'text-ink-secondary hover:bg-black/[0.06] hover:text-ink'
                                                                }`}
                                                            >
                                                                删除
                                                            </button>
                                                        </span>
                                                    </span>
                                                </>
                                            )}
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    </>
                )}
            </nav>
        </aside>
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

/** 相对时间（一周内用相对表述，更久用日期）。 */
function formatWhen(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return '';
    }
    const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
    if (minutes < 1) {
        return '刚刚';
    }
    if (minutes < 60) {
        return `${minutes} 分钟前`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours} 小时前`;
    }
    const days = Math.floor(hours / 24);
    if (days < 7) {
        return `${days} 天前`;
    }
    return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}
