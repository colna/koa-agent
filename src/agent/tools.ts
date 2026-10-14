import { tool } from '@langchain/core/tools';
import { z } from 'zod';

export class ExpressionError extends Error {}

type Token =
    | { kind: 'number'; value: number }
    | { kind: 'operator'; value: '+' | '-' | '*' | '/' }
    | { kind: 'lparen' }
    | { kind: 'rparen' };

function isDigit(ch: string): boolean {
    return ch >= '0' && ch <= '9';
}

function tokenize(expression: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;

    while (i < expression.length) {
        const ch = expression[i] as string;

        if (/\s/.test(ch)) {
            i += 1;
            continue;
        }

        if (isDigit(ch)) {
            let j = i;
            while (j < expression.length && /[0-9.]/.test(expression[j] as string)) {
                j += 1;
            }
            const raw = expression.slice(i, j);
            const value = Number(raw);
            if (!Number.isFinite(value)) {
                throw new ExpressionError(`无法识别的数字 "${raw}"`);
            }
            tokens.push({ kind: 'number', value });
            i = j;
            continue;
        }

        if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
            tokens.push({ kind: 'operator', value: ch });
            i += 1;
            continue;
        }
        if (ch === '(') {
            tokens.push({ kind: 'lparen' });
            i += 1;
            continue;
        }
        if (ch === ')') {
            tokens.push({ kind: 'rparen' });
            i += 1;
            continue;
        }

        throw new ExpressionError(`含非法字符 "${ch}"`);
    }

    return tokens;
}

class ExpressionParser {
    private pos = 0;

    constructor(private readonly tokens: Token[]) {}

    parse(): number {
        if (this.tokens.length === 0) {
            throw new ExpressionError('表达式为空');
        }
        const value = this.parseExpression();
        if (this.pos < this.tokens.length) {
            throw new ExpressionError('表达式结构不合法');
        }
        return value;
    }

    private peek(): Token | undefined {
        return this.tokens[this.pos];
    }

    private parseExpression(): number {
        let value = this.parseTerm();
        for (;;) {
            const token = this.peek();
            if (token?.kind !== 'operator' || (token.value !== '+' && token.value !== '-')) {
                break;
            }
            this.pos += 1;
            const rhs = this.parseTerm();
            value = token.value === '+' ? value + rhs : value - rhs;
        }
        return value;
    }

    private parseTerm(): number {
        let value = this.parseUnary();
        for (;;) {
            const token = this.peek();
            if (token?.kind !== 'operator' || (token.value !== '*' && token.value !== '/')) {
                break;
            }
            this.pos += 1;
            const rhs = this.parseUnary();
            if (token.value === '*') {
                value *= rhs;
            } else {
                if (rhs === 0) {
                    throw new ExpressionError('除数不能为 0');
                }
                value /= rhs;
            }
        }
        return value;
    }

    private parseUnary(): number {
        const token = this.peek();
        if (token?.kind === 'operator' && (token.value === '-' || token.value === '+')) {
            this.pos += 1;
            const value = this.parseUnary();
            return token.value === '-' ? -value : value;
        }
        return this.parsePrimary();
    }

    private parsePrimary(): number {
        const token = this.peek();
        if (token === undefined) {
            throw new ExpressionError('表达式意外结束');
        }
        if (token.kind === 'number') {
            this.pos += 1;
            return token.value;
        }
        if (token.kind === 'lparen') {
            this.pos += 1;
            const value = this.parseExpression();
            const closing = this.peek();
            if (closing?.kind !== 'rparen') {
                throw new ExpressionError('括号不匹配');
            }
            this.pos += 1;
            return value;
        }
        throw new ExpressionError('表达式结构不合法');
    }
}

export function evaluateExpression(expression: string): number {
    return new ExpressionParser(tokenize(expression)).parse();
}

export const calculatorTool = tool(
    ({ expression }) => {
        try {
            return String(evaluateExpression(expression));
        } catch (err) {
            return err instanceof ExpressionError ? `错误：${err.message}` : '错误：表达式不合法';
        }
    },
    {
        name: 'calculator',
        description:
            '计算数学表达式，仅支持四则运算、括号、小数与负号。入参 expression 为表达式字符串，例如 "1+2*3"。',
        schema: z.object({ expression: z.string().min(1).max(200) }),
    },
);

export const currentTimeTool = tool(
    ({ timezone }) => {
        try {
            const formatter = new Intl.DateTimeFormat('zh-CN', {
                timeZone: timezone,
                hour12: false,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
            });
            return `${formatter.format(new Date())}（${timezone}）`;
        } catch {
            return `错误：时区 "${timezone}" 不合法`;
        }
    },
    {
        name: 'current_time',
        description:
            '获取当前时间。可选 timezone 传 IANA 时区名（如 "Asia/Shanghai"、"America/New_York"），默认 "Asia/Shanghai"。',
        schema: z.object({ timezone: z.string().min(1).max(100).default('Asia/Shanghai') }),
    },
);

export const agentTools = [calculatorTool, currentTimeTool];
