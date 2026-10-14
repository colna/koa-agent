/**
 * 工具集测试：求值器（优先级 / 括号 / 负数 / 除零 / 非法输入）
 * 与两个工具的行为（错误以文本返回、zod 入参校验、时区处理）。
 */
import { describe, expect, it } from 'vitest';
import { calculatorTool, currentTimeTool, ExpressionError, evaluateExpression } from './tools.js';

describe('evaluateExpression', () => {
    it.each([
        ['1+2*3', 7],
        ['(1+2)*3', 9],
        ['0.5*4', 2],
        ['-5+2', -3],
        ['10/4', 2.5],
        [' ( 1 + 2 ) * ( 3 - 1 ) ', 6],
        ['2*-3', -6],
    ])('%s = %s', (expression, expected) => {
        expect(evaluateExpression(expression)).toBe(expected);
    });

    it.each(['1/0', '(1+2', '1+abc', '1 2', '', ')(', '1+', '.5', '1.2.3'])(
        '非法输入抛出 ExpressionError：%j',
        (expression) => {
            expect(() => evaluateExpression(expression)).toThrow(ExpressionError);
        },
    );
});

describe('calculatorTool', () => {
    it('返回计算结果字符串', async () => {
        await expect(calculatorTool.invoke({ expression: '1+2*3' })).resolves.toBe('7');
    });

    it('除零返回错误文本', async () => {
        await expect(calculatorTool.invoke({ expression: '1/0' })).resolves.toContain(
            '除数不能为 0',
        );
    });

    it('非法表达式返回错误文本', async () => {
        await expect(calculatorTool.invoke({ expression: '1+abc' })).resolves.toContain('错误');
    });

    it('入参校验：空表达式拒绝', async () => {
        await expect(calculatorTool.invoke({ expression: '' })).rejects.toThrow();
    });
});

describe('currentTimeTool', () => {
    it('默认时区返回格式化时间', async () => {
        const result = await currentTimeTool.invoke({});
        expect(result).toMatch(/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}（Asia\/Shanghai）/);
    });

    it('指定时区生效', async () => {
        const result = await currentTimeTool.invoke({ timezone: 'America/New_York' });
        expect(result).toContain('America/New_York');
    });

    it('非法时区返回错误文本', async () => {
        const result = await currentTimeTool.invoke({ timezone: 'Not/AZone' });
        expect(result).toContain('错误');
    });
});
