import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
    title: 'koa-agent · 聊天',
    description: 'Koa 3 + LangGraph Agent 服务的可视化界面（学习项目）',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
    return (
        <html lang="zh-CN" className="h-full">
            <body className="h-full bg-surface font-sans text-ink antialiased">{children}</body>
        </html>
    );
}
