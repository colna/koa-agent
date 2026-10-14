/**
 * 极简 URL 切分器：把文本切成「普通文本 / URL」片段，供聊天气泡把链接渲染成 <a>。
 * 只识别 http(s):// 开头的 URL（不做 Markdown 解析，够用且安全）；
 * 尾部标点（空格、中英文引号括号等）不吞进 URL。
 *
 * 每个片段附带 `offset`（在原文中的起始位置）——内容是文本切分的天然稳定标识，
 * 可直接用作 React list key（优于数组下标：不随渲染方式变化）。
 */
export interface TextSegment {
    type: 'text' | 'url';
    value: string;
    offset: number;
}

const URL_PATTERN = /https?:\/\/[^\s<>"'“”（）()]+/g;

export function splitTextByUrls(text: string): TextSegment[] {
    const segments: TextSegment[] = [];
    let lastIndex = 0;

    for (const match of text.matchAll(URL_PATTERN)) {
        const index = match.index ?? 0;
        if (index > lastIndex) {
            segments.push({ type: 'text', value: text.slice(lastIndex, index), offset: lastIndex });
        }
        segments.push({ type: 'url', value: match[0], offset: index });
        lastIndex = index + match[0].length;
    }

    if (lastIndex < text.length) {
        segments.push({ type: 'text', value: text.slice(lastIndex), offset: lastIndex });
    }
    return segments;
}
