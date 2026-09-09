import Link from 'next/link';
import { MonitoringDashboard } from '@/components/MonitoringDashboard';
import { fetchRuns, fetchWorkers } from '@/lib/api/client';

/**
 * Страница мониторинга.
 *
 * Первый снимок данных берётся на сервере: страница не пуста до первого
 * опроса. Дальнейшее обновление выполняет клиентский компонент.
 */
export const dynamic = 'force-dynamic';

export const metadata = { title: 'Мониторинг обработки' };

export default async function MonitoringPage(): Promise<React.JSX.Element> {
  try {
    const [workers, runs] = await Promise.all([fetchWorkers(), fetchRuns(20)]);

    return (
      <>
        <p style={{ marginBottom: '1rem' }}>
          <Link href="/">← Каталог</Link>
        </p>
        <h2>Мониторинг обработки</h2>

        <MonitoringDashboard
          initial={{
            workers: workers.items,
            runs: runs.items,
            fetchedAt: new Date().toISOString(),
          }}
        />
      </>
    );
  } catch {
    return (
      <div className="empty-state">
        <h2 className="empty-state__title">Мониторинг недоступен</h2>
        <p>Не удалось получить данные о состоянии обработки.</p>
        <p>
          <Link href="/">Вернуться в каталог</Link>
        </p>
      </div>
    );
  }
}
