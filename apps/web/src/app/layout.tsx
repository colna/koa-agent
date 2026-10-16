import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
    title: 'Social Proxy Agent · 聊天',
    description: 'SP 运维 Agent：查日志 / 看板 / 报表的对话界面（Koa 3 + LangGraph）',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
    return (
        <html lang="zh-CN" className="h-full">
            <body className="h-full bg-surface font-sans text-ink antialiased">{children}</body>
        </html>
    );
}
