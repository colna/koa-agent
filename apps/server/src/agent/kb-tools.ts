/**
 * 知识库检索（RAG）：把 colna-memo（个人知识库）接入 Agent。
 *
 * 两个工具：
 * - `kb_search`：spawn `./colna search <query>`（该 CLI 内置 zvec 向量 + FTS 混合检索），
 *   返回匹配笔记的路径与片段；
 * - `kb_read`：安全读取 `memory/` 下的笔记全文（检索结果的补充，路径防穿越）。
 *
 * 设计取舍：
 * - 复用现成的混合检索索引（`colna` CLI），不在服务端重建 embedding——零额外依赖、
 *   与库里已有的语义索引保持一致；
 * - 未配置 `KB_MEMO_DIR` 时工具返回配置指引（与其他集成一致的「缺失不阻塞」模式）；
 * - 应用场景：排查问题前先查历史经验 / 决策记录（system prompt 行为准则里有教学）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { execFileAsync } from './skills.js';

/** ANSI 颜色码：用 fromCharCode 构造 ESC，绕开 lint 对 regex 字面量控制字符的限制。 */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const MAX_NOTE_CHARS = 20_000;

export interface KbToolsOptions {
    /** colna-memo 根目录（含 `./colna` CLI 与 `memory/`）；空 = 未配置。 */
    memoDir?: string;
    /** CLI 文件名（默认 colna，位于 memoDir 下，必须有可执行权限）。 */
    cliName?: string;
    /** 检索超时（毫秒），默认 30s（索引冷启动较慢）。 */
    timeoutMs?: number;
    /** 检索输出最大字符数（保护模型上下文），默认 8000。 */
    maxOutputChars?: number;
}

const MISSING_HINT =
    '知识库未配置：设置 KB_MEMO_DIR 指向 colna-memo 目录（见 apps/server/.env.example），重启服务后可用。';

export function createKbTools(options: KbToolsOptions = {}) {
    const { memoDir = '', cliName = 'colna', timeoutMs = 30_000, maxOutputChars = 8000 } = options;
    const memoryDir = memoDir.length > 0 ? join(memoDir, 'memory') : '';

    const kbSearch = tool(
        async (input) => {
            if (memoDir.length === 0) {
                return MISSING_HINT;
            }
            const cli = join(memoDir, cliName);
            if (!existsSync(cli)) {
                return `知识库 CLI 不存在：${cli}（检查 KB_MEMO_DIR 配置）`;
            }
            // colna 必须在库根目录下运行（用相对路径 ./colna 调用）
            const { stdout, stderr, code } = await execFileAsync(
                cli,
                ['search', input.query],
                {},
                timeoutMs,
                memoDir,
            );
            if (code !== 0) {
                const detail = (stderr.trim() || stdout.trim()).slice(0, 300);
                return `知识库检索失败（exit ${code}）：${detail}`;
            }
            let result = stdout.replace(ANSI, '').trim();
            if (result.length === 0) {
                return '知识库检索：无匹配结果。';
            }
            if (result.length > maxOutputChars) {
                result = `${result.slice(0, maxOutputChars)}\n…（输出过长已截断）`;
            }
            return result;
        },
        {
            name: 'kb_search',
            description:
                '检索个人知识库（colna-memo：项目笔记、排错经验、决策记录；向量+FTS 混合检索）。' +
                '排查问题前、或用户问「之前 / 上次 / 历史有没有相关经验」时先检索；' +
                '返回匹配笔记的路径与片段，需要全文再用 kb_read（路径如 30-Resources/troubleshooting/xxx.md）。',
            schema: z.object({
                query: z.string().min(1).max(300).describe('检索关键词（中英文均可）'),
            }),
        },
    );

    const kbRead = tool(
        async (input) => {
            if (memoryDir.length === 0) {
                return MISSING_HINT;
            }
            const base = resolve(memoryDir);
            const target = resolve(base, input.path);
            // 路径防穿越：必须落在 memory/ 目录内（kb_search 返回的相对路径可直接使用）
            if (target !== base && !target.startsWith(base + sep)) {
                return '拒绝：path 必须在知识库 memory/ 目录内（使用 kb_search 结果里的相对路径）。';
            }
            try {
                const content = readFileSync(target, 'utf8');
                return content.length > MAX_NOTE_CHARS
                    ? `${content.slice(0, MAX_NOTE_CHARS)}\n…（笔记过长已截断）`
                    : content;
            } catch {
                return `读取失败：${input.path}（不存在或不可读）`;
            }
        },
        {
            name: 'kb_read',
            description:
                '读取知识库笔记全文（path 来自 kb_search 结果，相对 memory/ 目录，如 30-Resources/troubleshooting/xxx.md）。',
            schema: z.object({
                path: z.string().min(1).describe('相对 memory/ 的笔记路径'),
            }),
        },
    );

    return { kbSearch, kbRead };
}
