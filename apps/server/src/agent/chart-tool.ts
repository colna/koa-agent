/**
 * 图表工具：当模型判断结果适合可视化时，把数据整理成图表规格（ChartSpec）。
 *
 * 工作方式：
 * - 工具本身不画图（服务端无 UI）——它只**校验并回传规格**；规格进入流式
 *   回答后，由两处消费：
 *   1. 流式路由（routes/agent.ts）：tool.end 里发现 render_chart 的结果 → 追加
 *      `event: chart` SSE 帧 → 前端 ECharts 实时渲染；
 *   2. 历史回读（toHistory）：从 ToolMessage 里提取规格挂在对应助手消息上；
 * - 约束数据来自已有工具结果（prompt 里强调不要臆造）；kind 三选一：
 *   line（趋势）/ bar（对比）/ pie（占比分布）。
 *
 * 与其他工具一致的约定：永不抛异常（校验失败返回可读错误文本，让模型自行修正）。
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

/** 图表类型。 */
export const CHART_KINDS = ['line', 'bar', 'pie'] as const;

/** 图表规格（前后端共享的数据契约；web 侧同名类型在 `apps/web/src/lib/api.ts`）。 */
export interface ChartSpec {
    kind: (typeof CHART_KINDS)[number];
    title: string;
    /** 类目轴标签（pie 为各扇区名称）。 */
    categories: string[];
    /** 数据系列；pie 只取第一个。 */
    series: { name: string; data: number[] }[];
    /** 数值单位（y 轴展示，如「人 / 条 / ms」）。 */
    unit?: string;
}

const MAX_CATEGORIES = 200;
const MAX_SERIES = 10;

/** 从工具结果文本里解析图表规格；非图表结果（错误文本等）返回 null。 */
export function parseChartResult(text: string): ChartSpec | null {
    try {
        const data = JSON.parse(text) as { status?: unknown; spec?: unknown };
        if (data.status !== 'rendered' || typeof data.spec !== 'object' || data.spec === null) {
            return null;
        }
        const spec = data.spec as Partial<ChartSpec>;
        if (
            (spec.kind !== 'line' && spec.kind !== 'bar' && spec.kind !== 'pie') ||
            typeof spec.title !== 'string' ||
            !Array.isArray(spec.categories) ||
            !Array.isArray(spec.series)
        ) {
            return null;
        }
        return spec as ChartSpec;
    } catch {
        return null;
    }
}

export function createChartTool() {
    return tool(
        async (input) => {
            const expected = input.categories.length;

            // pie 只用第一个 series；多传的 series 忽略（结果里附提示）
            const usedSeries = input.kind === 'pie' ? input.series.slice(0, 1) : input.series;
            const mismatched = usedSeries.find((s) => s.data.length !== expected);
            if (mismatched !== undefined) {
                return `错误：series「${mismatched.name}」数据长度（${mismatched.data.length}）与 categories 长度（${expected}）不一致，请对齐后重试。`;
            }

            const spec: ChartSpec = {
                kind: input.kind,
                title: input.title,
                categories: input.categories,
                series: usedSeries,
                ...(input.unit !== undefined ? { unit: input.unit } : {}),
            };
            return JSON.stringify(
                {
                    status: 'rendered',
                    spec,
                    说明: '图表已加入界面；正文结论可直接引用该图，不必重复输出全部数据。',
                    ...(input.kind === 'pie' && input.series.length > 1
                        ? { 提示: 'pie 只使用第一个 series，其余已忽略' }
                        : {}),
                },
                null,
                2,
            );
        },
        {
            name: 'render_chart',
            description:
                '把分析结果渲染为图表展示给用户（前端 ECharts 实时渲染）。数据适合可视化时使用：' +
                '时间趋势→line；类别对比→bar；占比分布→pie。' +
                '数据必须来自已有工具结果或用户提供，不要臆造；一次调用出一张图，多图分多次调用。' +
                'categories 与每个 series.data 必须等长（pie 只用第一个 series）。',
            schema: z.object({
                kind: z.enum(CHART_KINDS).describe('图表类型：line=趋势 / bar=对比 / pie=占比分布'),
                title: z.string().min(1).max(80).describe('图表标题（简洁描述这张图是什么）'),
                categories: z
                    .array(z.string())
                    .min(1)
                    .max(MAX_CATEGORIES)
                    .describe(`类目轴标签（pie 为各扇区名称），最多 ${MAX_CATEGORIES} 个`),
                series: z
                    .array(
                        z.object({
                            name: z.string().min(1).max(40).describe('系列名（图例）'),
                            data: z.array(z.number()).describe('数值数组，与 categories 等长'),
                        }),
                    )
                    .min(1)
                    .max(MAX_SERIES)
                    .describe(`数据系列，最多 ${MAX_SERIES} 个（pie 只用第一个）`),
                unit: z.string().max(10).optional().describe('数值单位（如「人 / 条 / ms」）'),
            }),
        },
    );
}
