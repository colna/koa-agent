/**
 * 图表工具测试：规格校验（长度对齐 / pie 单系列）+ 结果解析（parseChartResult 往返）。
 */
import { describe, expect, it } from 'vitest';
import { createChartTool, parseChartResult } from './chart-tool.js';

describe('render_chart', () => {
    it('合法规格 → rendered + 原样回传 spec（可被 parseChartResult 解析）', async () => {
        const tool = createChartTool();
        const text = (await tool.invoke({
            kind: 'line',
            title: '每日错误趋势',
            categories: ['10-13', '10-14', '10-15'],
            series: [{ name: '错误数', data: [3, 5, 2] }],
            unit: '条',
        })) as string;

        const data = JSON.parse(text) as { status: string; spec: unknown };
        expect(data.status).toBe('rendered');

        const spec = parseChartResult(text);
        expect(spec).toMatchObject({
            kind: 'line',
            title: '每日错误趋势',
            categories: ['10-13', '10-14', '10-15'],
            series: [{ name: '错误数', data: [3, 5, 2] }],
            unit: '条',
        });
    });

    it('series 长度与 categories 不一致 → 可读错误文本（不抛异常）', async () => {
        const tool = createChartTool();
        const text = (await tool.invoke({
            kind: 'bar',
            title: '对比',
            categories: ['a', 'b'],
            series: [{ name: 's1', data: [1] }],
        })) as string;
        expect(text).toContain('不一致');
        expect(parseChartResult(text)).toBeNull();
    });

    it('pie 多 series → 只用第一个并附提示', async () => {
        const tool = createChartTool();
        const text = (await tool.invoke({
            kind: 'pie',
            title: '占比',
            categories: ['x', 'y'],
            series: [
                { name: 'main', data: [70, 30] },
                { name: 'ignored', data: [1, 2] },
            ],
        })) as string;
        const spec = parseChartResult(text);
        expect(spec?.series).toHaveLength(1);
        expect(spec?.series[0]?.name).toBe('main');
        expect(text).toContain('只使用第一个');
    });

    it('parseChartResult 对非图表文本返回 null', () => {
        expect(parseChartResult('随便一句错误文本')).toBeNull();
        expect(parseChartResult('{"status":"other"}')).toBeNull();
    });
});
