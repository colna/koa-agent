/**
 * 工具集：LLM Agent 的「手脚」。本文件教两个东西——
 *
 * 1. **LangChain 工具的定义方式**（`tool()` 函数）：
 *    一个工具 = 名字 + 给模型看的描述 + zod 参数 schema + 执行函数。
 *    schema 会被序列化成 JSON Schema 随请求发给模型（Function Calling），
 *    模型据此决定何时调、传什么参数；执行结果以 ToolMessage 回灌，
 *    继续下一轮推理（循环逻辑在 graph.ts）。
 *
 * 2. **安全求值器写法**（calculator）：
 *    数学表达式求值绝不可以用 `eval` / `new Function`（注入风险）。
 *    这里手写「词法分析（tokenize）+ 递归下降解析（ExpressionParser）」，
 *    只认数字、四则运算、括号、小数与正负号，其余一律拒绝。
 *
 * 设计约定：工具执行**出错不抛异常**，而是返回「错误：...」文本。
 * 因为工具结果是给模型看的 —— 模型收到错误描述后可以自行纠正重试；
 * 抛出异常反而会中断整张图。
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

/** 表达式非法时抛出的类型化错误（计算器内部使用；会被转成错误文本返回模型）。 */
export class ExpressionError extends Error {}

/** 词法单元（token）：表达式被切开后的最小元素。 */
type Token =
    | { kind: 'number'; value: number }
    | { kind: 'operator'; value: '+' | '-' | '*' | '/' }
    | { kind: 'lparen' }
    | { kind: 'rparen' };

function isDigit(ch: string): boolean {
    return ch >= '0' && ch <= '9';
}

/**
 * 词法分析：从左到右把字符串切成一串 token，遇到不认识的东西直接拒绝。
 * 例：`"1.5 * (2 + 3)"` → number(1.5)、operator(*)、lparen、number(2)……
 */
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
                // 例如 "1.2.3" —— 被贪婪切成一坨后 Number() 得到 NaN
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

/**
 * 递归下降解析器：按优先级从低到高逐层下降。
 *
 * 文法（EBNF）：
 *   expression := term { ("+" | "-") term }     ← 加减最低优先级
 *   term       := unary { ("*" | "/") unary }   ← 乘除更高
 *   unary      := ("+" | "-") unary | primary   ← 正负号（可叠加，如 --3）
 *   primary    := number | "(" expression ")"   ← 数字或括号（递归回顶层）
 *
 * 「优先级」不是写在注释里的，而是由调用层次天然决定：
 * term 先于加减结合，所以 1+2*3 中 2*3 会被先在 term 层算完。
 */
class ExpressionParser {
    private pos = 0;

    constructor(private readonly tokens: Token[]) {}

    /** 入口：解析完整表达式；多余的 token（如 "1 2"）视为结构非法。 */
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
                // 除零是「可解释的业务错误」，抛出去让工具层转成错误文本给模型
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
            const value = this.parseExpression(); // 括号内递归回最低优先级
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

/** 对外暴露的求值入口：tokenize → 解析。非法输入抛 ExpressionError。 */
export function evaluateExpression(expression: string): number {
    return new ExpressionParser(tokenize(expression)).parse();
}

/**
 * 计算器工具。注意 schema：`expression` 的 min/max 与类型约束是给模型的
 * 「参数说明」，模型生成非法参数时 LangChain 会在调用前就拒绝。
 * 执行函数捕获 ExpressionError 并返回错误文本（见文件头注释的设计约定）。
 */
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

/**
 * 当前时间工具。用 Intl.DateTimeFormat 做时区换算 —— Node 内置 IANA 时区库，
 * 非法时区名会抛 RangeError，捕获后同样以「错误：...」文本返回（不中断图）。
 * schema 里的 `.default('Asia/Shanghai')`：模型不传时区时自动补默认值。
 */
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

/** 图装配时使用的默认工具清单（graph.ts 引用）。 */
export const agentTools = [calculatorTool, currentTimeTool];
