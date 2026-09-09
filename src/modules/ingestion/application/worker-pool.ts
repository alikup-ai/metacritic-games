/**
 * Пул воркеров с ограниченным параллелизмом.
 *
 * Promise.all по всему батчу не годится: 20 одновременных задач нарушили бы
 * лимит обращений к источнику и создали бы пик нагрузки на БД. Здесь число
 * одновременно выполняемых задач ограничено явно.
 *
 * Реализация в application-слое и не зависит от Node-specific API: только
 * промисы и таймеры, передаваемые снаружи.
 */

export interface WorkerPoolOptions {
  readonly concurrency: number;
  /** Останавливает выдачу новых задач; уже начатые завершаются. */
  readonly signal?: AbortSignal;
}

export interface WorkerTaskOutcome<T, R> {
  readonly item: T;
  readonly status: 'fulfilled' | 'rejected' | 'skipped';
  readonly value?: R;
  readonly error?: unknown;
}

export interface WorkerPoolResult<T, R> {
  readonly outcomes: readonly WorkerTaskOutcome<T, R>[];
  readonly succeeded: number;
  readonly failed: number;
  /** Задачи, не запущенные из-за остановки пула. */
  readonly skipped: number;
}

/**
 * Выполняет задачи с ограничением параллелизма.
 *
 * Свойства, важные для корректности:
 * - одновременно выполняется не более `concurrency` задач;
 * - ошибка одной задачи НЕ останавливает остальные — каждая изолирована;
 * - при отмене уже начатые задачи доводятся до конца (graceful shutdown),
 *   а новые не запускаются.
 */
export async function runWorkerPool<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  options: WorkerPoolOptions,
): Promise<WorkerPoolResult<T, R>> {
  const concurrency = Math.max(1, Math.floor(options.concurrency));
  const outcomes: WorkerTaskOutcome<T, R>[] = new Array(items.length);

  let nextIndex = 0;
  let stopped = false;

  const onAbort = (): void => {
    stopped = true;
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) stopped = true;

  /** Одна «дорожка» пула: последовательно берёт задачи из общей очереди. */
  const lane = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;

      const item = items[index] as T;

      if (stopped) {
        // Новые задачи не запускаем, но помечаем явно: молчаливая потеря
        // элементов выглядела бы как успешная обработка.
        outcomes[index] = { item, status: 'skipped' };
        continue;
      }

      try {
        const value = await worker(item, index);
        outcomes[index] = { item, status: 'fulfilled', value };
      } catch (error) {
        // Изоляция: падение одной задачи не влияет на соседние дорожки.
        outcomes[index] = { item, status: 'rejected', error };
      }
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, items.length) }, () => lane()),
    );
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }

  const settled = outcomes.filter((outcome) => outcome !== undefined);

  return {
    outcomes: settled,
    succeeded: settled.filter((o) => o.status === 'fulfilled').length,
    failed: settled.filter((o) => o.status === 'rejected').length,
    skipped: settled.filter((o) => o.status === 'skipped').length,
  };
}

/**
 * Периодически продлевает аренду, пока выполняется работа.
 *
 * Без этого длительная обработка пережила бы срок аренды, и reaper вернул бы
 * заявку в пул ПАРАЛЛЕЛЬНО с продолжающейся работой — то есть игра
 * обрабатывалась бы дважды.
 */
export async function withHeartbeat<T>(
  work: () => Promise<T>,
  heartbeat: () => Promise<void>,
  options: {
    readonly intervalMs: number;
    readonly setInterval: (fn: () => void, ms: number) => unknown;
    readonly clearInterval: (handle: unknown) => void;
    readonly onError?: (error: unknown) => void;
  },
): Promise<T> {
  const handle = options.setInterval(() => {
    void heartbeat().catch((error: unknown) => {
      // Сбой продления не должен ронять саму работу: аренда может
      // истечь, но это штатно обрабатывается reaper'ом.
      options.onError?.(error);
    });
  }, options.intervalMs);

  try {
    return await work();
  } finally {
    options.clearInterval(handle);
  }
}
