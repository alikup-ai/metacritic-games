import { createServer, type Server } from 'node:http';
import type { Logger } from '../shared/logging/logger.js';
import { handleRequest, Router, type Handler } from './http/router.js';

/**
 * HTTP-сервер.
 *
 * Отвечает только за приём соединений и корректное завершение. Сборка
 * зависимостей — в composition root, маршруты — в routes.
 */

export interface ApiServerOptions {
  readonly router: Router;
  readonly logger: Logger;
  readonly port: number;
  readonly host: string;
}

export interface RunningServer {
  readonly port: number;
  readonly server: Server;
  close(): Promise<void>;
}

export function createApiServer(options: ApiServerOptions): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, {
      router: options.router,
      logger: options.logger,
    });
  });
}

export async function startApiServer(options: ApiServerOptions): Promise<RunningServer> {
  const server = createApiServer(options);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;

  options.logger.info('HTTP-сервер запущен', {
    operation: 'api_start',
    port,
    host: options.host,
  });

  return {
    port,
    server,
    /**
     * Корректное завершение: новые соединения не принимаются, текущие
     * запросы доводятся до конца.
     */
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Соединения keep-alive не закрылись бы сами и удерживали бы
        // сервер открытым до истечения тайм-аута.
        server.closeIdleConnections();
      });
    },
  };
}

export type { Handler };
export { Router };
