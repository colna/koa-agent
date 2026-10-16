/**
 * threadToMarkdown 单测（纯函数，离线）。
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './api';
import { threadToMarkdown } from './export';

describe('threadToMarkdown', () => {
    it('按提问/回答分段，工具调用折叠为引用行（去重）', () => {
        const messages: ChatMessage[] = [
            { id: '1', role: 'user', content: '查一下日志' },
            {
                id: '2',
                role: 'assistant',
                content: '结论：一切正常。',
                toolEvents: [
                    { name: 'sls_query_log', args: '{}', result: 'ok' },
                    { name: 'sls_query_log', args: '{}', result: 'ok2' },
                    { name: 'sp_dashboard_query', args: '{}', result: 'ok3' },
                ],
            },
        ];
        const md = threadToMarkdown('t_abc', messages, new Date('2026-10-15T12:00:00Z'));
        expect(md).toContain('# Social Proxy Agent 会话记录');
        expect(md).toContain('- 会话 ID：`t_abc`');
        expect(md).toContain('## 提问\n\n查一下日志');
        expect(md).toContain('> 工具调用：查询 SLS 日志、查询链路看板');
        expect(md).toContain('结论：一切正常。');
    });

    it('空会话也能生成（仅头部）', () => {
        const md = threadToMarkdown('', [], new Date('2026-10-15T12:00:00Z'));
        expect(md).toContain('（未命名）');
        expect(md).not.toContain('## 提问');
    });
});
