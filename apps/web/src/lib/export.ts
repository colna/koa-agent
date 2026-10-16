/**
 * 会话导出：把消息列表序列化为 Markdown（贴飞书 / 存档用），
 * 以及浏览器端下载工具。纯函数部分可离线测试。
 */
import type { ChatMessage } from './api';
import { toolLabel } from './tool-labels';

/**
 * 生成 Markdown 会话记录：
 * - 头部含会话 ID 与导出时间（北京时间）；
 * - 助手消息若带工具调用，先给一行「工具调用：…」引用块（便于分享时交代证据来源）。
 */
export function threadToMarkdown(
    threadId: string,
    messages: ChatMessage[],
    now: Date = new Date(),
): string {
    const lines: string[] = [
        '# Social Proxy Agent 会话记录',
        '',
        `- 会话 ID：\`${threadId.length > 0 ? threadId : '（未命名）'}\``,
        `- 导出时间：${now.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}`,
        '',
    ];

    for (const message of messages) {
        lines.push(message.role === 'user' ? '## 提问' : '## 回答', '');
        const tools = message.toolEvents ?? [];
        if (tools.length > 0) {
            const names = [...new Set(tools.map((event) => toolLabel(event.name)))];
            lines.push(`> 工具调用：${names.join('、')}`, '');
        }
        const content = message.content.trim();
        if (content.length > 0) {
            lines.push(content, '');
        }
    }

    return lines.join('\n');
}

/** 触发浏览器下载一个 .md 文件。 */
export function downloadMarkdown(fileName: string, content: string): void {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
}
