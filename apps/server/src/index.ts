/**
 * 进程入口：只做与「生命周期」相关的四件事——
 *   1) 加载 .env（loadDotEnv）
 *   2) 校验配置（loadConfig，失败 fail-fast）
 *   3) 组装依赖并启动（createModel → createAgentGraph → createApp → startServer）
 *   4) 注册优雅退出（setupGracefulShutdown）
 *
 * 业务逻辑都在其它模块；这里只负责「接线」，各部件因此可以单独测试
 * （见 src/index.test.ts：入口守卫保证 import 本文件不会真的启动服务）。
 */
import { pathToFileURL } from 'node:url';
import { createCheckpointer } from './agent/checkpoint.js';
import { createAgentGraph } from './agent/graph.js';
import { createModel } from './agent/model.js';
import { createSpTools } from './agent/sp-tools.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { defaultLog, type LogFn } from './middleware/logger.js';
import { agentRouter } from './routes/agent.js';
import { spRouter } from './routes/sp.js';
import { type RunningServer, startServer } from './server.js';
import { SpAdminClient } from './sp/client.js';

/**
 * 把项目根目录的 .env 读进 process.env（Node ≥ 20.12 的 process.loadEnvFile）。
 * 容错设计：.env 不存在是正常情况（例如生产环境直接用真实环境变量注入），
 * 因此吞掉异常继续走。注意只在「入口」调用一次；其它模块一律通过
 * Config 对象拿配置，绝不自读 env。
 */
export function loadDotEnv(): void {
    try {
        process.loadEnvFile();
    } catch {
        // 无 .env 时按当前环境变量运行
    }
}

/**
 * 注册 SIGINT / SIGTERM 优雅退出：
 * 收到信号 → 关闭 server（不再接新请求、等在途请求收尾）→ 以退出码结束进程。
 * 返回一个 dispose 函数用于摘掉监听 —— 测试里防止污染进程全局状态。
 *
 * 可测性技巧：`exit` 做成可注入参数 —— 测试传 mock 后就不怕真把测试进程杀掉
 * （见 src/index.test.ts；注意手动 process.emit('SIGTERM') 时要带信号名参数，
 * 否则监听器收到 undefined）。
 */
export function setupGracefulShutdown(
    running: RunningServer,
    log: LogFn,
    exit: (code: number) => void = (code) => process.exit(code),
): () => void {
    const shutdown = (signal: NodeJS.Signals) => {
        log({ level: 'info', message: `收到 ${signal}，优雅退出` });
        void running.close().then(
            () => exit(0),
            () => exit(1),
        );
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    return () => {
        process.removeListener('SIGINT', shutdown);
        process.removeListener('SIGTERM', shutdown);
    };
}

/**
 * 主装配流程：loadDotEnv → loadConfig → 组装 model / graph / app → 起服务 → 挂信号处理。
 * log 依赖显式传入（默认 stdout；测试传收集器断言启动日志）。
 */
export async function main(log: LogFn = defaultLog): Promise<RunningServer> {
    loadDotEnv();
    const config = loadConfig();
    const spClient = new SpAdminClient({
        baseUrl: config.SP_ADMIN_BASE_URL,
        token: config.SP_ADMIN_TOKEN,
    });
    const spTools = createSpTools({
        client: spClient,
        reportDir: config.SP_REPORT_DIR,
        serverBaseUrl: `http://${config.HOST}:${config.PORT}`,
    });
    const graph = createAgentGraph({
        model: createModel(config),
        checkpointer: createCheckpointer(config.AGENT_SQLITE_PATH),
        tools: [...Object.values(spTools)],
    });
    const app = createApp({
        log,
        routes: [agentRouter({ graph, log }), spRouter({ reportDir: config.SP_REPORT_DIR })],
        corsOrigin: config.CORS_ORIGIN,
    });
    const running = await startServer(app, config.PORT, config.HOST);
    log({ level: 'info', message: '服务已启动', url: running.url });
    setupGracefulShutdown(running, log);
    return running;
}

/**
 * 「入口守卫」：仅当本文件被直接运行（node dist/index.js / tsx src/index.ts）时启动服务；
 * 被 import（如测试）则不启动。判据：Node 启动脚本 argv[1] 是否等于本模块的 URL。
 */
const isEntrypoint =
    process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
    main().catch((err) => {
        // 启动失败（如 ConfigError 配置缺失）：打印可读信息，以非 0 退出码结束
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
    });
}
