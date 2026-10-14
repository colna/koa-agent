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
    await once(server, 'listening');
    const address = server.address() as AddressInfo;

    return {
        server,
        port: address.port,
        url: `http://${host}:${address.port}`,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((err) => (err ? reject(err) : resolve()));
            }),
    };
}
