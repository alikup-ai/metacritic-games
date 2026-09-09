import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiRequestError, fetchRun } from '@/lib/api/client';
import {
  formatDuration,
  formatMoment,
  runStatusLabel,
  stageLabel,
} from '@/lib/monitoring';

/**
 * Детали запуска.
 *
 * Серверный компонент: обновление здесь не нужно — завершённый запуск
 * не меняется, а идущий виден на общей странице мониторинга.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
  readonly params: Promise<{ id: string }>;
}

export default async function RunPage({ params }: PageProps): Promise<React.JSX.Element> {
  const { id } = await params;

  let run;
  let missing = false;

  try {
    run = await fetchRun(id);
  } catch (error) {
    if (error instanceof ApiRequestError && (error.isNotFound || error.status === 400)) {
      missing = true;
    } else {
      return (
        <div className="empty-state">
          <h2 className="empty-state__title">Данные недоступны</h2>
          <p>Не удалось загрузить сведения о запуске.</p>
          <p>
            <Link href="/monitoring">Вернуться к мониторингу</Link>
          </p>
        </div>
      );
    }
  }

  // notFound() вне catch: внутри обработчика он был бы перехвачен
  if (missing || !run) notFound();

  return (
    <>
      <p style={{ marginBottom: '1rem' }}>
        <Link href="/monitoring">← Мониторинг</Link>
      </p>

      <h2>Запуск от {formatMoment(run.startedAt)}</h2>

      <section className="section">
        <div className="analysis-card__header">
          <h3>Итоги</h3>
          <span className={`badge badge--run-${run.status}`}>
            {runStatusLabel(run.status)}
          </span>
        </div>

        <dl className="definition-list">
          <dt>Запуск</dt>
          <dd>{run.trigger === 'manual' ? 'вручную' : 'по расписанию'}</dd>

          <dt>Сутки обработки</dt>
          <dd>{run.processingDay ?? '—'}</dd>

          <dt>Длительность</dt>
          <dd>{formatDuration(run)}</dd>

          <dt>Завершён</dt>
          <dd>{formatMoment(run.finishedAt)}</dd>

          <dt>Взято в работу</dt>
          <dd>
            {run.claimed} из {run.planned} запланированных
          </dd>

          <dt>Полностью успешно</dt>
          <dd>{run.succeeded}</dd>

          <dt>Частично</dt>
          <dd>{run.partial}</dd>

          <dt>С ошибками</dt>
          <dd>{run.failed}</dd>

          {run.source ? (
            <>
              <dt>Источник выборки</dt>
              <dd>{run.source}</dd>
            </>
          ) : null}
        </dl>

        {run.errorSummary ? (
          <p className="notice">Ошибка: {run.errorSummary}</p>
        ) : null}
      </section>

      <section className="section">
        <h3>Стадии обработки</h3>

        {run.stages.length === 0 ? (
          <p className="notice">Сведений о стадиях нет</p>
        ) : (
          <div className="table-scroll">
            <table className="platform-table">
              <thead>
                <tr>
                  <th scope="col">Стадия</th>
                  <th scope="col">Выполнено</th>
                  <th scope="col">Пропущено</th>
                  <th scope="col">Ошибки</th>
                </tr>
              </thead>
              <tbody>
                {run.stages.map((stage) => (
                  <tr key={stage.stage}>
                    <th scope="row">{stageLabel(stage.stage)}</th>
                    <td>{stage.done}</td>
                    <td>{stage.skipped > 0 ? stage.skipped : '—'}</td>
                    <td>{stage.failed > 0 ? stage.failed : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
