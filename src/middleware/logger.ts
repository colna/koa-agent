/**
 * 请求日志中间件：每个请求输出一行 JSON（ts / method / path / status / durationMs）。
 *
 * 两个设计点：
 * 1. 工厂模式 —— loggerMiddleware(log) 返回中间件，log 可注入：
 *    生产用 defaultLog（console 打 JSON 行），测试传数组收集器即可断言；
 * 2. 挂在中间件链最外层（见 app.ts）—— await next() 覆盖后续全部处理，
 *    无论请求成功还是被 error 中间件兜住，都能记录到最终状态码与耗时。
 */
import type { Middleware } from 'koa';

/** 日志函数签名：接收一行结构化数据。默认实现打到 stdout（一行一条，便于采集）。 */
export type LogFn = (line: Record<string, unknown>) => void;

export const defaultLog: LogFn = (line) => console.log(JSON.stringify(line));

export function loggerMiddleware(log: LogFn): Middleware {
    return async (ctx, next) => {
        const start = Date.now();
        await next(); // 进入内层中间件；等整个请求处理完再回到这里
        log({
            ts: new Date().toISOString(),
            method: ctx.method,
            path: ctx.path,
            status: ctx.status, // 此刻状态码已被路由或 error 中间件定稿
            durationMs: Date.now() - start,
        });
    };
}
