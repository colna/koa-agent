import type { Middleware } from 'koa';

export type LogFn = (line: Record<string, unknown>) => void;

export const defaultLog: LogFn = (line) => console.log(JSON.stringify(line));

export function loggerMiddleware(log: LogFn): Middleware {
    return async (ctx, next) => {
        const start = Date.now();
        await next();
        log({
            ts: new Date().toISOString(),
            method: ctx.method,
            path: ctx.path,
            status: ctx.status,
            durationMs: Date.now() - start,
        });
    };
}
