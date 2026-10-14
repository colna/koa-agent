/**
 * 领域错误类型：把「HTTP 状态码 + 业务错误码 + 可选详情」绑定在一个错误对象上。
 *
 * 用法（见 src/routes/agent.ts）：
 *     throw new HttpError(502, 'AGENT_ERROR', 'Agent 运行失败');
 *
 * 错误中间件（src/middleware/error.ts）识别到它后原样映射为统一错误响应：
 *     { "error": { "code": "AGENT_ERROR", "message": "Agent 运行失败" } }
 *
 * 好处：路由只负责「抛对错误」，不必自己拼响应体；输出格式集中在一个出口。
 */
export class HttpError extends Error {
    readonly status: number;
    readonly code: string;
    readonly details?: unknown;

    constructor(status: number, code: string, message: string, details?: unknown) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
        this.code = code;
        this.details = details;
    }
}
