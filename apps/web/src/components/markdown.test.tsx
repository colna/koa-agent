/**
 * MarkdownContent 渲染测试：用 react-dom/server 做静态渲染断言（无需 jsdom/RTL）。
 * 覆盖 GFM 表格、加粗、链接（target=_blank）、代码块。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownContent } from './markdown';

describe('MarkdownContent', () => {
    it('渲染 GFM 表格', () => {
        const html = renderToStaticMarkup(
            <MarkdownContent text={'| 项目 | 值 |\n|---|---|\n| 在线数 | 1 |'} />,
        );
        expect(html).toContain('<table');
        expect(html).toContain('<th');
        expect(html).toContain('在线数');
    });

    it('加粗与链接（新窗口打开）', () => {
        const html = renderToStaticMarkup(
            <MarkdownContent text={'**重要** 见 https://example.com/x'} />,
        );
        expect(html).toContain('<strong');
        expect(html).toContain('href="https://example.com/x"');
        expect(html).toContain('target="_blank"');
    });

    it('代码块渲染为 pre', () => {
        const html = renderToStaticMarkup(<MarkdownContent text={'```js\nconsole.log(1)\n```'} />);
        expect(html).toContain('<pre');
        expect(html).toContain('console.log(1)');
    });

    it('有序列表', () => {
        const html = renderToStaticMarkup(<MarkdownContent text={'1. 第一步\n2. 第二步'} />);
        expect(html).toContain('<ol');
        expect(html).toContain('第一步');
    });
});
