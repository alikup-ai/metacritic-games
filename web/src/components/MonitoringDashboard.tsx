'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import type { RunListItem, WorkerStatus } from '@/lib/api/types';
import {
  displayStatus,
  formatAgo,
  formatDuration,
  formatMoment,
  runStatusLabel,
  workerStatusLabel,
} from '@/lib/monitoring';
import { startProcessing, type TriggerState } from '@/app/monitoring/actions';

/**
 * Панель мониторинга.
 *
 * Клиентский компонент: нужны периодическое обновление и обработка
 * нажатия. Данные приходят с сервера Next — адрес бэкенда и админ-токен
 * в браузер не попадают.
 *
 * Обновление сделано опросом: событийного потока в бэкенде нет, а
 * строить его ради одной страницы неоправданно.
 */

/** Интервал опроса, пока вкладка активна. */
const POLL_INTERVAL_MS = 4000;

interface MonitoringData {
  readonly workers: readonly WorkerStatus[];
  readonly runs: readonly RunListItem[];
  readonly fetchedAt: string;
}

interface MonitoringDashboardProps {
  /** Данные, отрисованные на сервере: страница не пуста до первого опроса. */
  readonly initial: MonitoringData;
}

export function MonitoringDashboard({
  initial,
}: MonitoringDashboardProps): React.JSX.Element {
  const [data, setData] = useState<MonitoringData>(initial);
  const [stale, setStale] = useState(false);
  const [trigger, setTrigger] = useState<TriggerState>({ kind: 'idle', message: '' });
  const [isPending, startTransition] = useTransition();

  // Текущее время нужно для «сколько назад»; обновляется вместе с данными
  const [now, setNow] = useState(() => Date.now());

  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    // Медленный ответ не должен накапливать параллельные запросы
    if (inFlight.current) return;
    inFlight.current = true;

    try {
      const response = await fetch('/api/monitoring', { cache: 'no-store' });
      if (!response.ok) {
        setStale(true);
        return;
      }

      setData((await response.json()) as MonitoringData);
      setNow(Date.now());
      setStale(false);
    } catch {
      // Сеть пропала — показываем прежние данные с пометкой
      setStale(true);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = (): void => {
      if (timer !== null) return;
      timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    };

    const stop = (): void => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };

    // Опрос идёт только когда вкладка видна: невидимая страница не
    // должна нагружать сервер.
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        void refresh();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh]);

  const worker = data.workers[0];
  const status = worker ? displayStatus(worker, now) : 'idle';
  const activeRun = data.runs.find((run) => run.status === 'running') ?? null;

  const onStart = (): void => {
    startTransition(async () => {
      const result = await startProcessing();
      setTrigger(result);
      await refresh();
    });
  };

  return (
    <>
      <section className="section" aria-labelledby="worker-heading">
        <div className="analysis-card__header">
          <h3 id="worker-heading">Обработчик</h3>
          <span className={`badge badge--${status}`}>{workerStatusLabel(status)}</span>
        </div>

        {stale ? (
          <p className="notice">
            Данные могли устареть: последнее обновление не удалось получить
          </p>
        ) : null}

        <dl className="definition-list">
          <dt>Последний отклик</dt>
          <dd>
            {worker?.lastHeartbeat
              ? `${formatAgo(worker.lastHeartbeat, now)} (${formatMoment(worker.lastHeartbeat)})`
              : '—'}
          </dd>

          <dt>Текущий запуск</dt>
          <dd>
            {activeRun ? (
              <Link href={`/monitoring/runs/${activeRun.id}`}>
                от {formatMoment(activeRun.startedAt)}
              </Link>
            ) : (
              'нет'
            )}
          </dd>

          {activeRun ? (
            <>
              <dt>Идёт</dt>
              <dd>{formatDuration(activeRun, now)}</dd>

              <dt>Обработано</dt>
              <dd>
                {activeRun.processed}
                {activeRun.failed > 0 ? `, с ошибками ${activeRun.failed}` : ''}
              </dd>
            </>
          ) : null}
        </dl>

        <div>
          <button
            type="button"
            className="button"
            onClick={onStart}
            disabled={isPending || status === 'running'}
          >
            {isPending ? 'Запускается…' : 'Запустить обработку'}
          </button>

          {status === 'running' ? (
            <p className="game-card__meta" style={{ marginTop: '0.5rem' }}>
              Обработка уже идёт — запуск станет доступен после её завершения
            </p>
          ) : null}

          {trigger.kind !== 'idle' ? (
            <p
              className={trigger.kind === 'error' ? 'notice' : 'game-card__meta'}
              style={{ marginTop: '0.5rem' }}
              role="status"
            >
              {trigger.message}
            </p>
          ) : null}
        </div>
      </section>

      <section className="section" aria-labelledby="runs-heading">
        <h3 id="runs-heading">Последние запуски</h3>

        {data.runs.length === 0 ? (
          <p className="notice">Запусков ещё не было</p>
        ) : (
          <div className="table-scroll">
            <table className="platform-table">
              <thead>
                <tr>
                  <th scope="col">Начало</th>
                  <th scope="col">Статус</th>
                  <th scope="col">Обработано</th>
                  <th scope="col">Ошибки</th>
                  <th scope="col">Длительность</th>
                  <th scope="col">Запуск</th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((run) => (
                  <tr key={run.id}>
                    <th scope="row">
                      <Link href={`/monitoring/runs/${run.id}`}>
                        {formatMoment(run.startedAt)}
                      </Link>
                    </th>
                    <td>
                      <span className={`badge badge--run-${run.status}`}>
                        {runStatusLabel(run.status)}
                      </span>
                    </td>
                    <td>{run.processed}</td>
                    <td>{run.failed > 0 ? run.failed : '—'}</td>
                    <td>{formatDuration(run, now)}</td>
                    <td>{run.trigger === 'manual' ? 'вручную' : 'по расписанию'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="game-card__meta" style={{ marginTop: '0.75rem' }}>
          Обновлено: {formatMoment(data.fetchedAt)}
        </p>
      </section>
    </>
  );
}
