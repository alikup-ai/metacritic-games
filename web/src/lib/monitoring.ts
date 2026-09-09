import type { RunListItem, RunStatus, WorkerStatus } from './api/types.js';

/**
 * Представление данных мониторинга.
 *
 * Только форматирование и производные состояния. Счётчики приходят с
 * бэкенда и здесь не пересчитываются.
 */

/**
 * Состояние обработчика для интерфейса.
 *
 * API различает только idle и running. 'stalled' выводится здесь: если
 * запуск числится работающим, но отметка живости давно не обновлялась,
 * процесс, вероятно, прерван. Это производная величина, а не поле API.
 */
export type DisplayWorkerStatus = 'idle' | 'running' | 'stalled';

/**
 * Порог устаревания отметки живости.
 *
 * Обработчик обновляет её каждые несколько минут (WORKER_HEARTBEAT_
 * INTERVAL_SECONDS, по умолчанию 180 с). Десять минут — с запасом:
 * случайная задержка не должна выглядеть как сбой.
 */
const STALE_HEARTBEAT_MS = 10 * 60 * 1000;

export function displayStatus(
  worker: WorkerStatus,
  now: number = Date.now(),
): DisplayWorkerStatus {
  if (worker.status !== 'running') return 'idle';
  if (!worker.lastHeartbeat) return 'running';

  const beat = Date.parse(worker.lastHeartbeat);
  if (!Number.isFinite(beat)) return 'running';

  return now - beat > STALE_HEARTBEAT_MS ? 'stalled' : 'running';
}

const WORKER_LABELS: Record<DisplayWorkerStatus, string> = {
  idle: 'простаивает',
  running: 'выполняется',
  stalled: 'нет отклика',
};

export function workerStatusLabel(status: DisplayWorkerStatus): string {
  return WORKER_LABELS[status];
}

const RUN_LABELS: Record<RunStatus, string> = {
  running: 'выполняется',
  completed: 'завершён',
  failed: 'ошибка',
  skipped: 'пропущен',
  blocked: 'заблокирован источником',
};

export function runStatusLabel(status: RunStatus): string {
  return RUN_LABELS[status] ?? status;
}

/** Момент времени в местном формате; null при отсутствии. */
export function formatMoment(value: string | null): string {
  if (!value) return '—';

  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '—';

  return new Date(ms).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** «12 секунд назад» — оператору важна свежесть, а не точное время. */
export function formatAgo(value: string | null, now: number = Date.now()): string {
  if (!value) return '—';

  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '—';

  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds} с назад`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} мин назад`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;

  return `${Math.round(hours / 24)} дн назад`;
}

/** Длительность запуска; для незавершённого считается до текущего момента. */
export function formatDuration(run: RunListItem, now: number = Date.now()): string {
  const start = Date.parse(run.startedAt);
  if (!Number.isFinite(start)) return '—';

  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  if (!Number.isFinite(end)) return '—';

  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds} с`;

  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest > 0 ? `${minutes} мин ${rest} с` : `${minutes} мин`;

  const hours = Math.floor(minutes / 60);
  return `${hours} ч ${minutes % 60} мин`;
}

/** Понятное название стадии вместо внутреннего идентификатора. */
const STAGE_LABELS: Record<string, string> = {
  fetchGame: 'Данные игры',
  fetchReviews: 'Отзывы',
  summarize: 'Разбор отзывов',
  similar: 'Похожие игры',
  youtube: 'YouTube',
};

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}
