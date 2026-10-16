/**
 * 消息气泡（纯展示组件）。
 * - 用户消息：右侧、Apple Blue 底、白字（纯文本 pre-wrap）；
 * - 助手消息：左侧、白底 + 柔和阴影，内容按 Markdown 渲染（表格 / 加粗 / 链接 / 代码块，
 *   见 markdown.tsx；报表下载链接因此可点击）；
 * - 错误消息：浅红底提示；
 * - 思考过程（reasoning）：气泡内顶部——浅色（次要文本色 13px）+ 左侧细线，
 *   「thinking」标签可折叠；正文（结果）保持深色 15px 常规样式，过程与结果样式区分；
 * - 助手消息上方：工具调用过程卡组——**默认收起只展示最新一条**，点「工具调用 · N 次」
 *   标题展开全部；单条时无标题直接展示。每张卡：执行中 spinner → 完成后折叠为摘要行、
 *   点开看参数/结果；
 * - 悬停（或键盘聚焦）气泡旁显示操作：复制（两侧都有）、撤回（最新一条用户消息）、
 *   重新生成（最新一条助手消息）；
 * - 进行中状态：显式 loading chip（spinner + 文案：thinking / 执行中… / 整理结果…），
 *   不再用闪烁光标表达「进行中」。
 */
import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, ToolEvent } from '@/lib/api';
import { formatFullTokens, formatTokens } from '@/lib/format';
import { toolLabel } from '@/lib/tool-labels';
import { ChartView } from './chart-view';
import { MarkdownContent } from './markdown';

export interface MessageBubbleProps {
    message: ChatMessage;
    /** 是否显示「撤回」按钮（仅最新一条用户消息，由 Chat 判定）。 */
    canRewind?: boolean;
    onRewind?: () => void;
    /** 是否显示「重新生成」按钮（仅最新一条助手消息，由 Chat 判定）。 */
    canRegenerate?: boolean;
    onRegenerate?: () => void;
}

export function MessageBubble({
    message,
    canRewind = false,
    onRewind,
    canRegenerate = false,
    onRegenerate,
}: MessageBubbleProps) {
    const isUser = message.role === 'user';
    // render_chart 是「展示型」工具：其产出以图表卡呈现，不再单独占一张工具卡
    const toolEvents =
        message.role === 'assistant'
            ? (message.toolEvents ?? []).filter((event) => event.name !== 'render_chart')
            : [];
    const charts = message.role === 'assistant' ? (message.charts ?? []) : [];
    const hasActivity = toolEvents.length > 0;
    const running = message.streaming === true;
    const reasoning = message.role === 'assistant' ? (message.reasoning ?? '') : '';
    const hasReasoning = reasoning.length > 0;
    const [copied, setCopied] = useState(false);
    /** 工具卡组展开态：默认收起（只展示最新一条），点标题切换。 */
    const [toolsOpen, setToolsOpen] = useState(false);

    const bubbleClass = isUser
        ? 'bg-accent text-white'
        : message.error
          ? 'bg-[#fff2f0] text-[#c62828]'
          : 'bg-surface-raised text-ink shadow-card';

    const showActions = message.content.length > 0;

    // 收起时仅渲染最新一条工具卡；展开时渲染全部（保持时间顺序）
    const visibleTools = toolsOpen
        ? toolEvents.map((event, index) => ({ event, index }))
        : toolEvents.length > 0
          ? [
                {
                    event: toolEvents[toolEvents.length - 1] as ToolEvent,
                    index: toolEvents.length - 1,
                },
            ]
          : [];
    // 图表卡（追加型列表；标题+序号消歧）
    const chartItems = charts.map((spec, index) => ({ spec, index }));

    async function handleCopy() {
        try {
            await navigator.clipboard.writeText(message.content);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
        } catch {
            // 剪贴板不可用（非安全上下文 / 无权限）：静默失败
        }
    }

    return (
        <div
            className={`group flex animate-rise items-center gap-2 ${isUser ? 'justify-end' : 'justify-start'}`}
        >
            {isUser && showActions ? (
                <ActionBar
                    copied={copied}
                    onCopy={handleCopy}
                    canRewind={canRewind}
                    onRewind={onRewind}
                />
            ) : null}
            <div
                className={`flex min-w-0 max-w-[85%] flex-col gap-1.5 ${isUser ? 'items-end' : 'items-start'}`}
            >
                {toolEvents.length > 0 ? (
                    <div className="flex w-full flex-col gap-1.5">
                        {toolEvents.length > 1 ? (
                            <button
                                type="button"
                                onClick={() => setToolsOpen((open) => !open)}
                                title={toolsOpen ? '收起（仅显示最新一条）' : '展开全部工具调用'}
                                className="flex items-center gap-1 self-start rounded-full px-1.5 py-0.5 text-[11px] leading-none text-ink-secondary transition hover:bg-surface hover:text-ink"
                            >
                                <svg
                                    width="9"
                                    height="9"
                                    viewBox="0 0 9 9"
                                    fill="none"
                                    aria-hidden
                                    className={`transition-transform duration-150 ${toolsOpen ? 'rotate-90' : ''}`}
                                >
                                    <path
                                        d="M3 1.5L6.5 4.5L3 7.5"
                                        stroke="currentColor"
                                        strokeWidth="1.4"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                    />
                                </svg>
                                工具调用 · {toolEvents.length} 次{toolsOpen ? '' : ' · 仅显示最新'}
                            </button>
                        ) : null}
                        {visibleTools.map(({ event, index }) => (
                            <ToolCard key={`${event.name}-${index}`} event={event} />
                        ))}
                    </div>
                ) : null}
                {charts.length > 0 ? (
                    <div className="flex w-full flex-col gap-1.5">
                        {chartItems.map(({ spec, index }) => (
                            <div
                                key={`${spec.title}-${index}`}
                                className="overflow-hidden rounded-[12px] border border-hairline bg-surface-raised p-3 shadow-card"
                            >
                                <p className="mb-1 text-[12px] font-medium text-ink">
                                    {spec.title}
                                </p>
                                <ChartView spec={spec} />
                            </div>
                        ))}
                    </div>
                ) : null}
                <div
                    className={`max-w-full min-w-0 rounded-[18px] px-4 py-2.5 text-[15px] leading-[1.47] ${bubbleClass} ${
                        isUser ? 'whitespace-pre-wrap' : ''
                    }`}
                >
                    {hasReasoning ? (
                        <ReasoningBlock
                            text={reasoning}
                            live={running && message.content.length === 0 && !hasActivity}
                        />
                    ) : null}
                    {running && message.content.length === 0 ? (
                        // 等待阶段：reasoning 正在浅色流式展示时不再叠加 chip；其余显式 loading 文案
                        hasReasoning && !hasActivity ? null : (
                            <LoadingChip
                                label={
                                    hasActivity
                                        ? toolEvents.at(-1)?.result === undefined
                                            ? '执行中…'
                                            : '整理结果…'
                                        : 'thinking'
                                }
                            />
                        )
                    ) : isUser ? (
                        message.content
                    ) : (
                        <>
                            <MarkdownContent text={message.content} />
                            {running ? (
                                <div className="mt-1.5">
                                    <LoadingChip />
                                </div>
                            ) : null}
                        </>
                    )}
                    {!isUser && message.usage !== undefined ? (
                        // token 消耗（收尾帧 / 历史回读）：浅色小字，悬浮显示完整数字
                        <p
                            className="mt-2 border-t border-hairline pt-1.5 text-[11px] leading-none text-ink-secondary"
                            title={`输入 ${formatFullTokens(message.usage.inputTokens)} / 输出 ${formatFullTokens(message.usage.outputTokens)} tokens`}
                        >
                            {formatTokens(message.usage.totalTokens)} tokens · 输入{' '}
                            {formatTokens(message.usage.inputTokens)} / 输出{' '}
                            {formatTokens(message.usage.outputTokens)}
                        </p>
                    ) : null}
                </div>
            </div>
            {!isUser && showActions ? (
                <ActionBar
                    copied={copied}
                    onCopy={handleCopy}
                    canRewind={canRewind}
                    onRewind={onRewind}
                    canRegenerate={canRegenerate}
                    onRegenerate={onRegenerate}
                />
            ) : null}
        </div>
    );
}

/** 悬停显示的操作条：复制 +（可选）撤回 / 重新生成。键盘聚焦时也可见（focus-within）。 */
function ActionBar({
    copied,
    onCopy,
    canRewind,
    onRewind,
    canRegenerate = false,
    onRegenerate,
}: {
    copied: boolean;
    onCopy: () => void;
    canRewind: boolean;
    onRewind?: (() => void) | undefined;
    canRegenerate?: boolean;
    onRegenerate?: (() => void) | undefined;
}) {
    const buttonClass =
        'rounded-full px-2 py-1 text-[11px] leading-none text-ink-secondary transition hover:bg-surface hover:text-ink';
    return (
        <div className="flex shrink-0 items-center gap-0.5 self-center opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
            <button type="button" onClick={onCopy} title="复制内容" className={buttonClass}>
                {copied ? '已复制' : '复制'}
            </button>
            {canRewind ? (
                <button
                    type="button"
                    onClick={onRewind}
                    title="撤回这条提问（同时删除服务端对应的问答记录）"
                    className={buttonClass}
                >
                    撤回
                </button>
            ) : null}
            {canRegenerate ? (
                <button
                    type="button"
                    onClick={onRegenerate}
                    title="撤回后可重新生成这轮回答"
                    className={buttonClass}
                >
                    重新生成
                </button>
            ) : null}
        </div>
    );
}

/** 截断长文本用于折叠态摘要。 */
function brief(text: string, max = 80): string {
    const oneLine = text.replaceAll('\n', ' ').trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * 进行中的 loading 标记：spinner + 文案（默认 "thinking"）。
 * 取代旧方案「闪烁光标暗示还在进行」——文案明确、动画集中在 spinner 上。
 */
function LoadingChip({ label = 'thinking' }: { label?: string }) {
    return (
        <span className="inline-flex items-center gap-1.5 text-[13px] leading-none text-ink-secondary">
            <span
                aria-hidden
                className="inline-block size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-ink-secondary/30 border-t-accent"
            />
            {label}
        </span>
    );
}

/**
 * 思考过程块（reasoning 流）：浅色过程样式 —— 次要文本色、13px、左侧细线；
 * 「thinking」标签可点击折叠（live 时显示 spinner，完成后显示箭头）。
 * 高度封顶（超长思考不撑爆消息流）+ 内部滚动；live 时自动跟随最新内容。
 * 与下方的正文（结果，深色 15px）形成「过程 / 结果」两种视觉层级。
 */
function ReasoningBlock({ text, live }: { text: string; live: boolean }) {
    const [open, setOpen] = useState(true);
    const scrollRef = useRef<HTMLDivElement | null>(null);

    // live 时跟随最新思考滚动到底（用户折叠或完成后不再打扰）。
    // text 是「触发信号」而非 effect 体内直接读取的值 —— signal-dependency 用法，显式忽略。
    // biome-ignore lint/correctness/useExhaustiveDependencies: 以 text 变化为滚动触发信号
    useEffect(() => {
        if (live) {
            scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
        }
    }, [text, live]);

    return (
        <div className="mb-2">
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                title={open ? '收起思考过程' : '展开思考过程'}
                className="flex items-center gap-1.5 text-[11px] leading-none text-ink-secondary/80 transition hover:text-ink-secondary"
            >
                {live ? (
                    <span
                        aria-hidden
                        className="inline-block size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-ink-secondary/30 border-t-accent"
                    />
                ) : (
                    <svg
                        width="9"
                        height="9"
                        viewBox="0 0 9 9"
                        fill="none"
                        aria-hidden
                        className={`transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
                    >
                        <path
                            d="M3 1.5L6.5 4.5L3 7.5"
                            stroke="currentColor"
                            strokeWidth="1.4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    </svg>
                )}
                thinking
            </button>
            {open ? (
                <div
                    ref={scrollRef}
                    className="mt-1.5 max-h-40 overflow-y-auto border-l-2 border-hairline pr-1 pl-3 text-[13px] leading-[1.6] whitespace-pre-wrap text-ink-secondary"
                >
                    {text}
                </div>
            ) : null}
        </div>
    );
}

/**
 * 单次工具调用的过程卡：
 * - 执行中：spinner + 标签（模型的过程文本 thought 作为引言显示）；
 * - 完成：折叠为一行「✓ 标签 · 结果摘要」，点击展开参数与完整结果。
 * 设计：贴合现有 Apple 风格令牌——浅灰底、hairline 边、小字号、无重阴影。
 */
function ToolCard({ event }: { event: ToolEvent }) {
    const [open, setOpen] = useState(false);
    const pending = event.result === undefined;

    return (
        <div className="overflow-hidden rounded-[12px] border border-hairline bg-surface">
            {event.thought !== undefined && event.thought.length > 0 ? (
                <p className="border-b border-hairline px-3 pt-2 pb-1.5 text-[12px] leading-[1.45] text-ink-secondary">
                    {event.thought}
                </p>
            ) : null}
            <button
                type="button"
                onClick={() => setOpen(!open)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-surface-raised/60"
            >
                {pending ? (
                    <span
                        aria-hidden
                        className="inline-block size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-ink-secondary/30 border-t-accent"
                    />
                ) : (
                    <span aria-hidden className="shrink-0 text-[11px] text-[#34c759]">
                        ✓
                    </span>
                )}
                <span className="min-w-0 flex-1 text-[12px] font-medium text-ink">
                    {toolLabel(event.name)}
                    {!pending && event.result !== undefined ? (
                        <span className="ml-1.5 font-normal text-ink-secondary">
                            {brief(event.result)}
                        </span>
                    ) : null}
                </span>
                {!pending ? (
                    <span aria-hidden className="shrink-0 text-[10px] text-ink-secondary">
                        {open ? '收起' : '详情'}
                    </span>
                ) : null}
            </button>
            {open && !pending ? (
                <div className="flex flex-col gap-2 border-t border-hairline px-3 py-2">
                    {event.args !== undefined ? (
                        <details className="group" open>
                            <summary className="cursor-pointer text-[11px] font-medium text-ink-secondary select-none">
                                参数
                            </summary>
                            <pre className="mt-1 overflow-x-auto rounded-[8px] bg-surface-raised px-2 py-1.5 font-mono text-[11px] leading-[1.5] text-ink">
                                {event.args}
                            </pre>
                        </details>
                    ) : null}
                    <details className="group" open>
                        <summary className="cursor-pointer text-[11px] font-medium text-ink-secondary select-none">
                            结果
                        </summary>
                        <pre className="mt-1 max-h-48 overflow-auto rounded-[8px] bg-surface-raised px-2 py-1.5 font-mono text-[11px] leading-[1.5] whitespace-pre-wrap text-ink">
                            {event.result}
                        </pre>
                    </details>
                </div>
            ) : null}
        </div>
    );
}
