/**
 * 消息气泡（纯展示组件）。
 * - 用户消息：右侧、Apple Blue 底、白字（纯文本 pre-wrap）；
 * - 助手消息：左侧、白底 + 柔和阴影，内容按 Markdown 渲染（表格 / 加粗 / 链接 / 代码块，
 *   见 markdown.tsx；报表下载链接因此可点击）；
 * - 错误消息：浅红底提示；流式进行中：末尾闪烁光标；尚无内容时显示「正在思考…」。
 */
import type { ChatMessage } from '@/lib/api';
import { MarkdownContent } from './markdown';

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
                className={`max-w-[85%] rounded-[18px] px-4 py-2.5 text-[15px] leading-[1.47] ${bubbleClass} ${
                    isUser ? 'whitespace-pre-wrap' : ''
                }`}
            >
                {message.streaming === true && message.content.length === 0 ? (
                    <span className="text-ink-secondary italic">正在思考…</span>
                ) : isUser ? (
                    message.content
                ) : (
                    <MarkdownContent text={message.content} />
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
