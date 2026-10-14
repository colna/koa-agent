/**
 * 统一错误出口（中间件链第 2 层，紧贴 logger 内侧）。
 *
 * 职责分两段，对应 try / catch：
 *
 * 1) `await next()` 正常返回后（try 上半段）——兜底「状态 >= 400 但没人写 body」：
 *    典型来源：@koa/router 的 allowedMethods 对方法不匹配只设 405 不设 body；
 *    未匹配到任何路由时只有隐式 404。Koa 默认会回纯文本，不符合本项目
 *    「统一 JSON 错误信封」的约定，这里补齐。
 *
 *    ⚠️ 本项目踩过的 Koa 坑：隐式 404 时 status 并非「显式设置」，
 *    此时直接赋 ctx.body 会触发 setter 把状态重置回 200！
 *    因此必须先 `ctx.status = status`（显式）再赋 body —— 顺序不能反。
 *
 * 2) 下游抛错时（catch 段）——按错误来源分类，转成统一信封
 *    `{ error: { code, message, details? } }`：
 *    - ZodError          → 422 VALIDATION_ERROR（路由里 schema.parse 失败，逐字段 details）；
 *    - HttpError         → 原样映射（业务主动抛的「已知错误」，如 404 / 502）；
 *    - 带 status 的 4xx  → 400 特判为坏 JSON（koa-bodyparser 抛的），其余按状态映射（405/415 等）；
 *    - 其它              → 500 INTERNAL：统一文案 + 只记日志，不向客户端泄漏内部信息。
 */
import type { Middleware } from 'koa';
import { ZodError } from 'zod';
import { HttpError } from '../errors.js';
import type { LogFn } from './logger.js';

/** 已知 4xx 状态 → 业务错误码的映射（要加错误码时在这里登记）。 */
const CLIENT_STATUS_CODES: Record<number, string> = {
    404: 'NOT_FOUND',
    405: 'METHOD_NOT_ALLOWED',
    415: 'UNSUPPORTED_MEDIA_TYPE',
};

/** 配套的人类可读文案（未登记的状态会落到下方的兜底值）。 */
const CLIENT_FALLBACK_MESSAGES: Record<number, string> = {
    404: '未知路由',
    405: '方法不允许',
    415: '不支持的媒体类型',
};

export function errorMiddleware(log?: LogFn): Middleware {
    return async (ctx, next) => {
        try {
            await next();

            // —— 场景一：状态 >= 400 但 body 为空（如 404 隐式状态、405 只设状态） ——
            const status = ctx.status;
            if (ctx.body == null && status >= 400) {
                ctx.status = status; // 先显式设状态（关键，见文件头注释），再赋 body
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
            // —— 场景二：分类映射（判断顺序即优先级） ——

            // zod 校验失败：返回 422 + 逐字段问题（path 用点号拼接，便于前端定位）
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

            // 业务主动抛出的已知错误：状态码 / 业务码 / 文案原样映射
            if (err instanceof HttpError) {
                ctx.status = err.status;
                ctx.body = {
                    error: { code: err.code, message: err.message, details: err.details },
                };
                return;
            }

            // http-errors 风格的错误带数字 status 字段（koa-bodyparser、allowedMethods 等）
            const status =
                typeof (err as { status?: unknown }).status === 'number'
                    ? (err as { status: number }).status
                    : 500;

            // 400 特判：bodyparser 解析坏 JSON 抛的 → 统一归为「校验类」422
            if (status === 400) {
                ctx.status = 422;
                ctx.body = {
                    error: { code: 'VALIDATION_ERROR', message: '请求体不是合法 JSON' },
                };
                return;
            }

            // 其余 4xx：状态沿用，文案用原始 message（这类信息本身不敏感）
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

            // 兜底 500：统一文案，细节（message/stack）只进日志，不泄漏给客户端
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
