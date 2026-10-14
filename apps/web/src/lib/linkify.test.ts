/**
 * splitTextByUrls 单测：纯文本 / 单个链接 / 多链接 / 尾部标点不吞入 / 空串；片段携带稳定 offset。
 */
import { describe, expect, it } from 'vitest';
import { splitTextByUrls } from './linkify';

describe('splitTextByUrls', () => {
    it('纯文本原样返回（offset=0）', () => {
        expect(splitTextByUrls('没有链接')).toEqual([
            { type: 'text', value: '没有链接', offset: 0 },
        ]);
    });

    it('单个链接切出三段且 offset 正确', () => {
        expect(splitTextByUrls('下载 https://example.com/a.csv 吧')).toEqual([
            { type: 'text', value: '下载 ', offset: 0 },
            { type: 'url', value: 'https://example.com/a.csv', offset: 3 },
            { type: 'text', value: ' 吧', offset: 28 },
        ]);
    });

    it('多个链接', () => {
        const segments = splitTextByUrls('http://a.com 和 https://b.com');
        expect(segments.filter((segment) => segment.type === 'url')).toHaveLength(2);
    });

    it('中文标点不吞入 URL', () => {
        expect(splitTextByUrls('看（https://example.com/x）')).toEqual([
            { type: 'text', value: '看（', offset: 0 },
            { type: 'url', value: 'https://example.com/x', offset: 2 },
            { type: 'text', value: '）', offset: 23 },
        ]);
    });

    it('空串返回空数组', () => {
        expect(splitTextByUrls('')).toEqual([]);
    });
});
