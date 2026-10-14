/**
 * 消息气泡（纯展示组件）。
 * - 用户消息：右侧、Apple Blue 底、白字；
 * - 助手消息：左侧、白底 + 单一柔和阴影（Apple 卡片风格）；内容中的 http(s) 链接
 *   会渲染为可点击 <a>（例如 SP 报表的下载链接）；
 * - 错误消息：浅红底提示（连接失败 / Agent 失败）；
 * - 流式进行中：末尾闪烁光标；尚无内容时显示「正在思考…」。
 */
import type { ChatMessage } from '@/lib/api';
import { splitTextByUrls } from '@/lib/linkify';

/** 按 URL 片段渲染文本（仅助手消息使用；用户消息保持纯文本）。 */
function renderWithLinks(text: string) {
    return splitTextByUrls(text).map((segment) =>
        segment.type === 'url' ? (
            <a
                key={segment.offset}
                href={segment.value}
                target="_blank"
                rel="noreferrer"
                className="break-all text-accent underline"
            >
                {segment.value}
            </a>
        ) : (
            <span key={segment.offset}>{segment.value}</span>
        ),
    );
}

export function MessageBubble({ message }: { message: ChatMessage }) {
    const isUser = message.role === 'user';

    const bubbleClass = isUser
        ? 'bg-accent text-white'
        : message.error
          ? 'bg-[#fff2f0] text-[#c62828]'
          : 'bg-surface-raised text-ink shadow-card';

    return (
        <div className={`flex animate-rise ${isUser ? 'justify-end' : 'justify-start'}`}>
            <div
                className={`max-w-[85%] rounded-[18px] px-4 py-2.5 text-[15px] leading-[1.47] whitespace-pre-wrap ${bubbleClass}`}
            >
                {message.streaming === true && message.content.length === 0 ? (
                    <span className="text-ink-secondary italic">正在思考…</span>
                ) : isUser ? (
                    message.content
                ) : (
                    renderWithLinks(message.content)
                )}
                {message.streaming === true && message.content.length > 0 ? (
                    <span
                        aria-hidden
                        className="ml-0.5 inline-block h-[1.1em] w-[2px] animate-blink rounded-full bg-current align-[-2px]"
                    />
                ) : null}
            </div>
        </div>
    );
}
