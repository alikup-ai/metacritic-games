import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApiServer } from '../../src/api/server.js';
import type { Router } from '../../src/api/server.js';
import { silentLogger } from '../../src/shared/logging/logger.js';

/**
 * Поднимает сервер на случайном порту для тестов.
 *
 * Запросы идут по настоящему HTTP: проверяются коды ответа, заголовки и
 * сериализация, а не только возвращаемые обработчиком объекты.
 */

export interface TestServer {
  readonly baseUrl: string;
  request(
    path: string,
    init?: { method?: string; headers?: Record<string, string>; body?: unknown },
  ): Promise<{ status: number; body: unknown; headers: Headers }>;
  close(): Promise<void>;
}

export async function startTestServer(router: Router): Promise<TestServer> {
  const server: Server = createApiServer({
    router,
    logger: silentLogger,
    port: 0,
    host: '127.0.0.1',
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    request: async (path, init) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method: init?.method ?? 'GET',
        ...(init?.headers ? { headers: init.headers } : {}),
        ...(init?.body !== undefined
          ? {
              body: JSON.stringify(init.body),
              headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
            }
          : {}),
      });

      const text = await response.text();
      let body: unknown = null;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }

      return { status: response.status, body, headers: response.headers };
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      });
    },
  };
}
