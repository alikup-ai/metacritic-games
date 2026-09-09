import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Каталог игр',
  description: 'Оценки, платформы и разбор отзывов об играх',
};

/**
 * Общий каркас страниц.
 *
 * Разметка семантическая: заголовок, основная область и ссылка перехода
 * к содержимому для навигации с клавиатуры.
 */
export default function RootLayout({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <html lang="ru">
      <body>
        <a className="skip-link" href="#main">
          Перейти к содержимому
        </a>

        <header className="site-header">
          <div className="container site-header__inner">
            <h1 className="site-header__title">
              <Link href="/">Каталог игр</Link>
            </h1>
            <span className="site-header__tagline">
              Оценки и разбор отзывов
            </span>
            <Link href="/monitoring" className="site-header__link">
              Мониторинг
            </Link>
          </div>
        </header>

        <main id="main" className="container">
          {children}
        </main>
      </body>
    </html>
  );
}
