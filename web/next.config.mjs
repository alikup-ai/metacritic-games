/**
 * Конфигурация Next.js.
 *
 * Браузер обращается только к своему origin: запросы к бэкенду идут
 * server-side. Поэтому CORS не нужен, а адрес API и секреты в клиентский
 * пакет не попадают.
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Отключаем заголовок с версией: лишние сведения о стеке ни к чему
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
