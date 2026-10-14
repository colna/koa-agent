/**
 * SP（social-proxy）接入层：经 minerva BFF 调用 SP 运维接口。
 *
 * 三个关键约定（来自 sitin-next feature/sp 源码勘察）：
 * 1. **双层 success**：BFF（Koa 反代）把上游响应包成 `{success, data}`，
 *    SP 自己还有一层业务结果（如 signal create 的内层 `{success, signal|error}`）
 *    —— 本 client 解掉外层，内层判断交给各工具按接口语义处理；
 * 2. **鉴权**：`Authorization: Bearer <minerva JWT>`（自签见 scripts/make-sp-token.mjs）；
 *    401/403 统一归一为「auth」错误并附更新 token 的指引；
 * 3. **错误归类**：所有失败归一为 SpClientError（kind: config/auth/api/connection），
 *    工具层直接把它转成给模型看的文本，不抛异常中断图。
 */
import { createWriteStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export type SpErrorKind = 'config' | 'auth' | 'api' | 'connection';

export class SpClientError extends Error {
    readonly kind: SpErrorKind;

    constructor(kind: SpErrorKind, message: string) {
        super(message);
        this.name = 'SpClientError';
        this.kind = kind;
    }
}

export interface SpClientOptions {
    baseUrl: string;
    token: string;
    timeoutMs?: number;
}

export interface SpRequestInput {
    path: string;
    method?: 'GET' | 'POST';
    query?: Record<string, string | number | undefined>;
    body?: unknown;
}

export class SpAdminClient {
    private readonly baseUrl: string;
    private readonly token: string;
    private readonly timeoutMs: number;

    constructor(options: SpClientOptions) {
        this.baseUrl = options.baseUrl.replace(/\/$/, '');
        this.token = options.token.trim();
        this.timeoutMs = options.timeoutMs ?? 20_000;
    }

    /** JSON 接口：解外层 `{success, data}` 返回内层 data；失败统一抛 SpClientError。 */
    async request<T>(input: SpRequestInput): Promise<T> {
        const res = await this.fetchWithAuth(input);
        this.assertAuthorized(res);

        const body = await readJsonRecord(res);
        if (body === null) {
            throw new SpClientError('api', `SP 接口返回了非 JSON 响应（HTTP ${res.status}）`);
        }
        if (body.success !== true) {
            throw new SpClientError('api', `SP 接口失败：${describeError(body.error)}`);
        }
        return body.data as T;
    }

    /** 非 JSON 接口（CSV 导出等）：流式落盘，返回写入字节数。 */
    async downloadToFile(input: SpRequestInput, filePath: string): Promise<number> {
        const res = await this.fetchWithAuth(input);
        this.assertAuthorized(res);

        if (!res.ok) {
            const body = await readJsonRecord(res);
            const detail = body !== null ? describeError(body.error) : `HTTP ${res.status}`;
            throw new SpClientError('api', `SP 导出失败：${detail}`);
        }
        if (res.body === null) {
            throw new SpClientError('api', 'SP 导出响应为空');
        }

        await pipeline(
            Readable.fromWeb(
                res.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
            ),
            createWriteStream(filePath),
        );
        return statSync(filePath).size;
    }

    private async fetchWithAuth(input: SpRequestInput): Promise<Response> {
        if (this.token.length === 0) {
            throw new SpClientError(
                'config',
                '未配置 SP_ADMIN_TOKEN —— 在 apps/server/.env 填入自签 token（生成方式见 scripts/make-sp-token.mjs 头部注释）',
            );
        }

        const url = this.buildUrl(input);
        try {
            return await fetch(url, {
                method: input.method ?? 'GET',
                headers: {
                    authorization: `Bearer ${this.token}`,
                    ...(input.body !== undefined ? { 'content-type': 'application/json' } : {}),
                },
                body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch (err) {
            if (
                err instanceof DOMException &&
                (err.name === 'TimeoutError' || err.name === 'AbortError')
            ) {
                throw new SpClientError(
                    'connection',
                    `SP 请求超时（${this.timeoutMs / 1000}s）：${url}`,
                );
            }
            throw new SpClientError(
                'connection',
                `无法连接 SP BFF（${this.baseUrl}）：${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    private assertAuthorized(res: Response): void {
        if (res.status === 401 || res.status === 403) {
            throw new SpClientError(
                'auth',
                `BFF 鉴权失败（HTTP ${res.status}）—— 请更新 apps/server/.env 的 SP_ADMIN_TOKEN（可能已过期或 secret 与所连环境不匹配）`,
            );
        }
    }

    private buildUrl(input: SpRequestInput): string {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(input.query ?? {})) {
            if (value !== undefined) {
                params.set(key, String(value));
            }
        }
        const qs = params.toString();
        return `${this.baseUrl}${input.path}${qs.length > 0 ? `?${qs}` : ''}`;
    }
}

async function readJsonRecord(res: Response): Promise<Record<string, unknown> | null> {
    try {
        const value: unknown = await res.json();
        return typeof value === 'object' && value !== null
            ? (value as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

function describeError(error: unknown): string {
    if (typeof error === 'string') {
        return error;
    }
    if (error !== null && typeof error === 'object') {
        const record = error as Record<string, unknown>;
        if (typeof record.message === 'string') {
            return record.message;
        }
        return JSON.stringify(record).slice(0, 300);
    }
    return String(error);
}
