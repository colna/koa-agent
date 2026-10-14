/**
 * 把 Koa app 变成「可直接使用、可关闭」的 HTTP server。
 *
 * 为什么不用 app.listen(...) 直接了事？两个测试 / 运维诉求：
 * - 默认 port = 0：让操作系统分配随机空闲端口（测试并行跑不会撞端口），
 *   启动后再从 address() 读回真实端口；
 * - close() 包成 Promise：优雅退出（index.ts）与测试收尾都需要 await 关闭完成，
 *   而 Node 原生 server.close(cb) 是回调风格。
 */
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type Koa from 'koa';

export interface RunningServer {
    server: Server;
    port: number;
    url: string;
    close(): Promise<void>;
}

export async function startServer(app: Koa, port = 0, host = '127.0.0.1'): Promise<RunningServer> {
    const server = app.listen(port, host);
    await once(server, 'listening'); // 等真正开始监听（此刻端口才可用，避免竞态）
    const address = server.address() as AddressInfo;

    return {
        server,
        port: address.port,
        url: `http://${host}:${address.port}`,
        close: () =>
            new Promise<void>((resolve, reject) => {
                // server.close：停止接收新连接，等在途请求处理完再回调
                server.close((err) => (err ? reject(err) : resolve()));
            }),
    };
}
