/**
 * CORS 中间件（浏览器跨域直连所需）。
 *
 * 为什么需要：web（Next.js，端口 3001）与 server（3000）不同源，浏览器用
 * fetch 直接调 server 接口（尤其是 POST + SSE 流式）会触发跨域限制。
 * 本项目特意选择「浏览器直连 server」而不加反向代理层 —— 依据知识库结论：
 * 反代层容易把流式响应整段缓冲，直连链路最短最稳。
 *
 * 行为：
 * - 普通请求：加 `Access-Control-Allow-Origin`；
 * - OPTIONS 预检（浏览器对 application/json 的 POST 会先发）：直接 204 +
 *   允许方法/头，不进后续中间件（也不会破坏 404/路由逻辑）；
 * - origin 为 '*'（默认，开发用）时不带 Vary；配置具体 origin 时加
 *   `Vary: Origin`，避免 CDN/代理把不同来源的响应缓存串味。
 */
import type { Middleware } from 'koa';

export function corsMiddleware(origin = '*'): Middleware {
    return async (ctx, next) => {
        ctx.set('Access-Control-Allow-Origin', origin);
        if (origin !== '*') {
            ctx.vary('Origin');
        }

        if (ctx.method === 'OPTIONS') {
            ctx.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
            ctx.set('Access-Control-Allow-Headers', 'Content-Type');
            ctx.set('Access-Control-Max-Age', '86400');
            ctx.status = 204;
            return;
        }

        await next();
    };
}
