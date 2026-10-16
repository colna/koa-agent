/**
 * 助手消息的 Markdown 渲染（react-markdown + remark-gfm）。
 *
 * 为什么需要：Agent 的回复（尤其 SP 报表）自带 Markdown 表格 / 加粗 / 代码块，
 * 纯文本 pre-wrap 渲染会露出 `|`、`**` 等裸符号，非常难读。
 *
 * 设计要点：
 * - 用 `components` 映射把各元素配成 Apple 风格 Tailwind 样式（紧凑尺寸适配气泡）；
 * - 安全：react-markdown 默认不渲染原始 HTML（无 innerHTML 注入面）；
 *   所有链接统一 `target="_blank" rel="noreferrer"`；
 * - GFM 扩展（表格、删除线、任务列表）由 remark-gfm 提供；
 * - 表格外层包横向滚动容器，窄屏不撑破气泡；
 * - 代码块右上角悬停出现「复制」按钮（直接取 pre 的 innerText，不依赖语法高亮结构）。
 */
import { useRef, useState } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components: Components = {
    h1: ({ children }) => (
        <h2 className="mt-3 mb-1.5 text-[17px] font-semibold first:mt-0">{children}</h2>
    ),
    h2: ({ children }) => (
        <h2 className="mt-3 mb-1.5 text-[17px] font-semibold first:mt-0">{children}</h2>
    ),
    h3: ({ children }) => (
        <h3 className="mt-3 mb-1 text-[15px] font-semibold first:mt-0">{children}</h3>
    ),
    p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-5">{children}</ul>,
    ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5">{children}</ol>,
    li: ({ children }) => <li className="leading-[1.47]">{children}</li>,
    a: ({ href, children }) => (
        <a href={href} target="_blank" rel="noreferrer" className="break-all text-accent underline">
            {children}
        </a>
    ),
    blockquote: ({ children }) => (
        <blockquote className="my-2 border-l-2 border-hairline pl-3 text-ink-secondary">
            {children}
        </blockquote>
    ),
    hr: () => <hr className="my-3 border-hairline" />,
    // 行内 code 无 language-xxx className；块级 code 在 pre 内，由 pre 统一上样式
    code: ({ className, children }) =>
        className !== undefined ? (
            <code className="font-mono text-[0.9em]">{children}</code>
        ) : (
            <code className="rounded bg-ink/5 px-1 py-0.5 font-mono text-[0.9em]">{children}</code>
        ),
    pre: CodeBlock,
    table: ({ children }) => (
        <div className="my-2 overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">{children}</table>
        </div>
    ),
    th: ({ children }) => (
        <th className="border-b border-hairline bg-surface px-2.5 py-1.5 text-left font-semibold whitespace-nowrap">
            {children}
        </th>
    ),
    td: ({ children }) => (
        <td className="border-b border-hairline px-2.5 py-1.5 align-top">{children}</td>
    ),
};

/** 代码块：pre + 悬停「复制」按钮。 */
function CodeBlock({ children }: { children?: React.ReactNode }) {
    const ref = useRef<HTMLPreElement | null>(null);
    const [copied, setCopied] = useState(false);

    async function copy() {
        const text = (ref.current?.innerText ?? '').trimEnd();
        if (text.length === 0) {
            return;
        }
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
        } catch {
            // 剪贴板不可用：静默失败
        }
    }

    return (
        <div className="group/code relative my-2">
            <button
                type="button"
                onClick={copy}
                className="absolute top-2 right-2 rounded-full bg-white/85 px-2 py-0.5 text-[11px] text-ink-secondary opacity-0 backdrop-blur transition group-hover/code:opacity-100 hover:text-ink focus-visible:opacity-100"
            >
                {copied ? '已复制' : '复制'}
            </button>
            <pre
                ref={ref}
                className="overflow-x-auto rounded-lg bg-ink/5 p-3 font-mono text-[13px] leading-relaxed"
            >
                {children}
            </pre>
        </div>
    );
}

export function MarkdownContent({ text }: { text: string }) {
    return (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
            {text}
        </ReactMarkdown>
    );
}
