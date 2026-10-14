import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type Koa from 'koa';

export interface TestServer {
    url: string;
    server: Server;
    close(): Promise<void>;
}

export async function startServer(app: Koa): Promise<TestServer> {
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;

    return {
        url: `http://127.0.0.1:${port}`,
        server,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((err) => (err ? reject(err) : resolve()));
            }),
    };
}
