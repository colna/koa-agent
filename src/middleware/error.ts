import type { Middleware } from 'koa';
import { ZodError } from 'zod';
import { HttpError } from '../errors.js';
import type { LogFn } from './logger.js';

const CLIENT_STATUS_CODES: Record<number, string> = {
    404: 'NOT_FOUND',
    405: 'METHOD_NOT_ALLOWED',
    415: 'UNSUPPORTED_MEDIA_TYPE',
};

const CLIENT_FALLBACK_MESSAGES: Record<number, string> = {
    404: '未知路由',
    405: '方法不允许',
    415: '不支持的媒体类型',
};

export function errorMiddleware(log?: LogFn): Middleware {
    return async (ctx, next) => {
        try {
            await next();
            const status = ctx.status;
            if (ctx.body == null && status >= 400) {
                ctx.status = status;
                ctx.body = {
                    error:
                        status >= 500
                            ? { code: 'INTERNAL', message: '服务器内部错误' }
                            : {
                                  code: CLIENT_STATUS_CODES[status] ?? 'HTTP_ERROR',
                                  message: CLIENT_FALLBACK_MESSAGES[status] ?? '请求错误',
                              },
                };
            }
        } catch (err) {
            if (err instanceof ZodError) {
                ctx.status = 422;
                ctx.body = {
                    error: {
                        code: 'VALIDATION_ERROR',
                        message: '请求体不合法',
                        details: err.issues.map((issue) => ({
                            path: issue.path.join('.'),
                            message: issue.message,
                            code: issue.code,
                        })),
                    },
                };
                return;
            }

            if (err instanceof HttpError) {
                ctx.status = err.status;
                ctx.body = {
                    error: { code: err.code, message: err.message, details: err.details },
                };
                return;
            }

            const status =
                typeof (err as { status?: unknown }).status === 'number'
                    ? (err as { status: number }).status
                    : 500;

            if (status === 400) {
                ctx.status = 422;
                ctx.body = {
                    error: { code: 'VALIDATION_ERROR', message: '请求体不是合法 JSON' },
                };
                return;
            }

            if (status >= 400 && status < 500) {
                ctx.status = status;
                ctx.body = {
                    error: {
                        code: CLIENT_STATUS_CODES[status] ?? 'HTTP_ERROR',
                        message: err instanceof Error ? err.message : '请求错误',
                    },
                };
                return;
            }

            ctx.status = 500;
            ctx.body = { error: { code: 'INTERNAL', message: '服务器内部错误' } };
            log?.({
                level: 'error',
                message: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
            });
        }
    };
}
