/**
 * 展示格式化小工具。
 */

/** token 数人性化：1234 → "1.2k"，45678 → "45.7k"，少于 1000 原样。 */
export function formatTokens(count: number): string {
    if (count < 1000) {
        return String(count);
    }
    return `${(count / 1000).toFixed(1)}k`;
}

/** 带千分位的完整数字（tooltip 用）：12345 → "12,345"。 */
export function formatFullTokens(count: number): string {
    return count.toLocaleString('en-US');
}
