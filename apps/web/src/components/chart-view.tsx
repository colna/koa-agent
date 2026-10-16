/**
 * 图表渲染（ECharts，按需动态 import 避免 SSR 触碰 DOM）。
 *
 * 设计：
 * - `echarts/core` + 按需注册（Line/Bar/Pie + Grid/Tooltip/Legend），控制打包体积；
 * - Apple 风格配色与克制样式：浅网格线、灰轴标签、Apple Blue 主色板、圆角图例；
 * - ResizeObserver 跟随容器尺寸变化（如侧栏折叠）；
 * - 卸载时 dispose，防止内存泄漏（多消息多图场景）。
 */
import { useEffect, useRef } from 'react';
import type { ChartSpec } from '@/lib/api';

/** Apple 风格图表配色（主色 Apple Blue 打头）。 */
const PALETTE = ['#0071e3', '#34c759', '#ff9f0a', '#ff3b30', '#5e5ce6', '#64d2ff', '#af52de'];

const AXIS_LABEL = { color: '#6e6e73', fontSize: 11 };
const GRID_LINE = { lineStyle: { color: 'rgba(0,0,0,0.06)' } };

/** ChartSpec → ECharts option。 */
function buildOption(spec: ChartSpec) {
    if (spec.kind === 'pie') {
        const first = spec.series[0];
        return {
            color: PALETTE,
            tooltip: { trigger: 'item' },
            legend: {
                bottom: 0,
                icon: 'circle',
                itemWidth: 8,
                itemHeight: 8,
                textStyle: { color: '#6e6e73', fontSize: 11 },
            },
            series: [
                {
                    type: 'pie',
                    radius: ['42%', '66%'],
                    center: ['50%', '44%'],
                    data: spec.categories.map((name, index) => ({
                        name,
                        value: first?.data[index] ?? 0,
                    })),
                    label: { color: '#6e6e73', fontSize: 11 },
                    itemStyle: { borderColor: '#fff', borderWidth: 2 },
                },
            ],
        };
    }
    return {
        color: PALETTE,
        tooltip: { trigger: 'axis' },
        legend:
            spec.series.length > 1
                ? {
                      top: 0,
                      icon: 'circle',
                      itemWidth: 8,
                      itemHeight: 8,
                      textStyle: { color: '#6e6e73', fontSize: 11 },
                  }
                : undefined,
        grid: {
            left: 8,
            right: 12,
            top: spec.series.length > 1 ? 30 : 16,
            bottom: 4,
            containLabel: true,
        },
        xAxis: {
            type: 'category',
            data: spec.categories,
            axisLine: { lineStyle: { color: 'rgba(0,0,0,0.12)' } },
            axisTick: { show: false },
            axisLabel: AXIS_LABEL,
        },
        yAxis: {
            type: 'value',
            name: spec.unit,
            nameTextStyle: AXIS_LABEL,
            splitLine: GRID_LINE,
            axisLabel: AXIS_LABEL,
        },
        series: spec.series.map((s) => ({
            name: s.name,
            type: spec.kind,
            data: s.data,
            smooth: spec.kind === 'line',
            symbolSize: 5,
            lineStyle: { width: 2 },
            barMaxWidth: 28,
            itemStyle: { borderRadius: spec.kind === 'bar' ? [3, 3, 0, 0] : 0 },
        })),
    };
}

export function ChartView({ spec }: { spec: ChartSpec }) {
    const containerRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        const el = containerRef.current;
        if (el === null) {
            return;
        }
        let disposed = false;
        let chart: {
            setOption: (option: unknown) => void;
            resize: () => void;
            dispose: () => void;
        } | null = null;
        let observer: ResizeObserver | null = null;

        void (async () => {
            const [core, charts, components, renderers] = await Promise.all([
                import('echarts/core'),
                import('echarts/charts'),
                import('echarts/components'),
                import('echarts/renderers'),
            ]);
            if (disposed) {
                return;
            }
            core.use([
                charts.LineChart,
                charts.BarChart,
                charts.PieChart,
                components.GridComponent,
                components.TooltipComponent,
                components.LegendComponent,
                renderers.CanvasRenderer,
            ]);
            chart = core.init(el);
            chart.setOption(buildOption(spec));
            observer = new ResizeObserver(() => chart?.resize());
            observer.observe(el);
        })();

        return () => {
            disposed = true;
            observer?.disconnect();
            chart?.dispose();
        };
    }, [spec]);

    return <div ref={containerRef} className="h-[240px] w-full" />;
}
