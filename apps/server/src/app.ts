/**
 * 应用装配层：把「中间件 + 路由」拼成一个 Koa app。
 *
 * 为什么单独一个文件？—— 装配与运行分离：
 * - createApp 是纯函数（给定依赖 → 返回 app）：不监听端口、不读 env；
 * - 端口监听在 server.ts；进程生命周期（信号、退出）在 index.ts。
 * 因此测试可以自由「createApp + 注入假路由 / 静音日志 + 随机端口起服务」。
 */
import type Router from '@koa/router';
import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import { corsMiddleware } from './middleware/cors.js';
import { errorMiddleware } from './middleware/error.js';
import { defaultLog, type LogFn, loggerMiddleware } from './middleware/logger.js';
import { healthRouter } from './routes/health.js';

export interface CreateAppOptions {
    /** 日志函数：默认 console JSON 行；测试注入收集器可断言。 */
    log?: LogFn;
    /** 额外路由：生产传 agentRouter()；测试注入探针路由（如故意抛错的路由）。 */
    routes?: Router[];
    /** CORS 允许的来源（默认 '*'，开发用）；生产可配置为 web 的具体域名。 */
    corsOrigin?: string;
}

export function createApp(options: CreateAppOptions = {}): Koa {
    const log = options.log ?? defaultLog;
    const app = new Koa();

    // 中间件顺序 = 洋葱包裹顺序（外层先拿到请求、最后拿到响应）：
    // - logger 必须最外层：无论后续成功还是出错，都能记录最终状态与耗时；
    // - error 在 logger 内侧：一切异常都会被它转成响应，不会冒泡出去打断 logger；
    // - bodyparser 在路由之前：路由拿到的 ctx.request.body 已是解析好的对象。
    app.use(loggerMiddleware(log));
    app.use(errorMiddleware(log));
    app.use(corsMiddleware(options.corsOrigin));
    app.use(bodyParser({ enableTypes: ['json'], jsonLimit: '1mb' }));

    // 逐个挂载路由：routes() 负责匹配与执行；allowedMethods() 负责
    // 「路径存在但方法不匹配」时回 405（只设状态，body 由 error 中间件兜底补齐）。
    const routers = [healthRouter(), ...(options.routes ?? [])];
    for (const router of routers) {
        app.use(router.routes());
        app.use(router.allowedMethods());
    }

    return app;
}
