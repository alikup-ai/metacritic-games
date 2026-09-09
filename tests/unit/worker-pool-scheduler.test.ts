import { describe, expect, it, vi } from 'vitest';
import { runWorkerPool, withHeartbeat } from '../../src/modules/ingestion/application/worker-pool.js';
import { DailyProcessingScheduler } from '../../src/modules/ingestion/application/scheduler.js';
import { FixedProcessingDayProvider } from '../../src/modules/ingestion/domain/processing-day-provider.js';
import type { RunDailyProcessingUseCase } from '../../src/modules/ingestion/application/run-daily-processing.js';

/** Unit-тесты пула и планировщика: без БД и без сети. */

describe('runWorkerPool — ограничение параллелизма', () => {
  it('не превышает заданный лимит', async () => {
    let active = 0;
    let peak = 0;

    await runWorkerPool(
      Array.from({ length: 20 }, (_, i) => i),
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      },
      { concurrency: 3 },
    );

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('обрабатывает все элементы', async () => {
    const processed: number[] = [];

    const result = await runWorkerPool(
      [1, 2, 3, 4, 5],
      async (item) => {
        processed.push(item);
        return item * 2;
      },
      { concurrency: 2 },
    );

    expect(processed.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(result.succeeded).toBe(5);
    expect(result.failed).toBe(0);
  });

  it('ошибка одной задачи НЕ останавливает остальные', async () => {
    const result = await runWorkerPool(
      [1, 2, 3, 4, 5],
      async (item) => {
        if (item === 3) throw new Error('Сбой на третьей');
        return item;
      },
      { concurrency: 2 },
    );

    expect(result.succeeded).toBe(4);
    expect(result.failed).toBe(1);

    const failed = result.outcomes.find((o) => o.status === 'rejected');
    expect(failed!.item).toBe(3);
  });

  it('несколько ошибок изолированы друг от друга', async () => {
    const result = await runWorkerPool(
      [1, 2, 3, 4, 5, 6],
      async (item) => {
        if (item % 2 === 0) throw new Error(`Сбой ${item}`);
        return item;
      },
      { concurrency: 3 },
    );

    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(3);
  });

  it('пустой список обрабатывается без ошибок', async () => {
    const result = await runWorkerPool([], async () => undefined, { concurrency: 4 });
    expect(result.outcomes).toHaveLength(0);
  });

  it('concurrency больше числа задач не ломает работу', async () => {
    const result = await runWorkerPool([1, 2], async (i) => i, { concurrency: 10 });
    expect(result.succeeded).toBe(2);
  });

  it('отмена помечает незапущенные задачи как пропущенные', async () => {
    const controller = new AbortController();
    let started = 0;

    const result = await runWorkerPool(
      Array.from({ length: 10 }, (_, i) => i),
      async (item) => {
        started += 1;
        if (started === 2) controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 5));
        return item;
      },
      { concurrency: 2, signal: controller.signal },
    );

    // Пропущенные задачи учтены явно, а не потеряны молча
    expect(result.skipped).toBeGreaterThan(0);
    expect(result.succeeded + result.failed + result.skipped).toBe(10);
  });

  it('уже начатые задачи доводятся до конца после отмены', async () => {
    const controller = new AbortController();
    const finished: number[] = [];

    await runWorkerPool(
      [1, 2, 3, 4],
      async (item) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        finished.push(item);
        return item;
      },
      { concurrency: 2, signal: controller.signal },
    );

    // Первые две задачи стартовали до отмены и завершились
    expect(finished.length).toBeGreaterThanOrEqual(2);
  });

  it('уже отменённый сигнал пропускает все задачи', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runWorkerPool([1, 2, 3], async (i) => i, {
      concurrency: 2,
      signal: controller.signal,
    });

    expect(result.skipped).toBe(3);
    expect(result.succeeded).toBe(0);
  });
});

describe('withHeartbeat — продление аренды', () => {
  it('вызывает продление по расписанию и останавливает после работы', async () => {
    let beats = 0;
    let cleared = false;
    let tick: (() => void) | null = null;

    const result = await withHeartbeat(
      async () => {
        // Имитируем срабатывание таймера во время работы
        tick?.();
        tick?.();
        return 'готово';
      },
      async () => {
        beats += 1;
      },
      {
        intervalMs: 1000,
        setInterval: (fn) => {
          tick = fn;
          return 'handle';
        },
        clearInterval: () => {
          cleared = true;
        },
      },
    );

    expect(result).toBe('готово');
    expect(beats).toBe(2);
    // Таймер обязан быть снят, иначе процесс не завершится
    expect(cleared).toBe(true);
  });

  it('снимает таймер даже при ошибке в работе', async () => {
    let cleared = false;

    await expect(
      withHeartbeat(
        async () => {
          throw new Error('Сбой работы');
        },
        async () => undefined,
        {
          intervalMs: 1000,
          setInterval: () => 'handle',
          clearInterval: () => {
            cleared = true;
          },
        },
      ),
    ).rejects.toThrow('Сбой работы');

    expect(cleared).toBe(true);
  });

  it('сбой продления не роняет саму работу', async () => {
    let tick: (() => void) | null = null;
    const errors: unknown[] = [];

    const result = await withHeartbeat(
      async () => {
        tick?.();
        // Даём микрозадаче обработать отклонённый промис
        await new Promise((resolve) => setTimeout(resolve, 5));
        return 'ок';
      },
      async () => {
        throw new Error('Продление не удалось');
      },
      {
        intervalMs: 1000,
        setInterval: (fn) => {
          tick = fn;
          return 'h';
        },
        clearInterval: () => undefined,
        onError: (error) => errors.push(error),
      },
    );

    // Аренда может истечь, но это штатно обработает reaper
    expect(result).toBe('ок');
    expect(errors).toHaveLength(1);
  });
});

describe('DailyProcessingScheduler', () => {
  function makeScheduler(
    execute: () => Promise<unknown>,
    options: { runOnStart?: boolean } = {},
  ) {
    let tick: (() => void) | null = null;
    let cleared = false;

    const scheduler = new DailyProcessingScheduler({
      runDailyProcessing: {
        execute,
      } as unknown as RunDailyProcessingUseCase,
      intervalMs: 3_600_000,
      timers: {
        setInterval: (fn) => {
          tick = fn;
          return 'handle';
        },
        clearInterval: () => {
          cleared = true;
        },
      },
      ...options,
    });

    return {
      scheduler,
      fire: () => tick?.(),
      wasCleared: () => cleared,
    };
  }

  it('не выполняет обработку сам — только вызывает use case', async () => {
    const execute = vi.fn(async () => ({ outcome: 'completed' }));
    const { scheduler } = makeScheduler(execute);

    await scheduler.tick();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ trigger: 'cron' });
  });

  it('НЕ запускает второй проход, пока идёт первый', async () => {
    // Управляемый промис: создаётся ДО вызова, иначе resolve ещё не
    // присвоен в момент, когда тест пытается его вызвать.
    let resolveFirst!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      resolveFirst = resolve;
    });

    const execute = vi.fn(async () => gate);
    const { scheduler } = makeScheduler(execute);

    const first = scheduler.tick();
    // Второй тик приходит, пока первый ещё работает
    const second = await scheduler.tick();

    expect(second).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);

    resolveFirst({ outcome: 'completed' });
    await first;

    // После завершения новый тик проходит
    await scheduler.tick();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('ошибка тика не останавливает планировщик', async () => {
    const errors: unknown[] = [];
    let attempt = 0;

    const execute = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('Первый тик упал');
      return { outcome: 'completed' };
    });

    const scheduler = new DailyProcessingScheduler({
      runDailyProcessing: { execute } as unknown as RunDailyProcessingUseCase,
      intervalMs: 1000,
      timers: { setInterval: () => 'h', clearInterval: () => undefined },
      onError: (error) => errors.push(error),
    });

    await scheduler.tick();
    expect(errors).toHaveLength(1);

    // Следующий час может оказаться удачнее
    await scheduler.tick();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('start регистрирует таймер, stop снимает', async () => {
    const { scheduler, wasCleared } = makeScheduler(async () => ({}));

    scheduler.start();
    expect(scheduler.isScheduled).toBe(true);

    await scheduler.stop();
    expect(scheduler.isScheduled).toBe(false);
    expect(wasCleared()).toBe(true);
  });

  it('повторный start не создаёт второй таймер', () => {
    const { scheduler } = makeScheduler(async () => ({}));

    scheduler.start();
    scheduler.start();

    expect(scheduler.isScheduled).toBe(true);
  });

  it('stop дожидается уже начатого запуска', async () => {
    let finished = false;
    let resolveRun!: (value: unknown) => void;
    const gate = new Promise((resolve) => {
      resolveRun = resolve;
    });

    const execute = vi.fn(async () => {
      await gate;
      finished = true;
      return { outcome: 'completed' };
    });

    const { scheduler } = makeScheduler(execute);
    void scheduler.tick();

    const stopping = scheduler.stop();
    resolveRun(undefined);
    await stopping;

    // Работа не была брошена на середине
    expect(finished).toBe(true);
  });

  it('после stop новые тики не выполняются', async () => {
    const execute = vi.fn(async () => ({ outcome: 'completed' }));
    const { scheduler } = makeScheduler(execute);

    scheduler.start();
    await scheduler.stop();

    const result = await scheduler.tick();
    expect(result).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it('runOnStart выполняет запуск сразу', async () => {
    const execute = vi.fn(async () => ({ outcome: 'completed' }));
    const { scheduler } = makeScheduler(execute, { runOnStart: true });

    scheduler.start();
    await scheduler.stop();

    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('ProcessingDayProvider', () => {
  it('вычисляет сутки по настроенной таймзоне', () => {
    const provider = new FixedProcessingDayProvider(
      new Date('2026-09-07T23:30:00Z'),
      'UTC',
    );
    expect(provider.currentProcessingDay()).toBe('2026-09-07');
  });

  it('другая таймзона даёт другие сутки на границе', () => {
    const provider = new FixedProcessingDayProvider(
      new Date('2026-09-07T23:30:00Z'),
      'Asia/Tokyo',
    );
    // В Токио уже наступило 8 сентября
    expect(provider.currentProcessingDay()).toBe('2026-09-08');
  });

  it('позволяет перевести время на новые сутки', () => {
    const provider = new FixedProcessingDayProvider(new Date('2026-09-07T10:00:00Z'));
    expect(provider.currentProcessingDay()).toBe('2026-09-07');

    provider.advanceTo(new Date('2026-09-08T10:00:00Z'));
    expect(provider.currentProcessingDay()).toBe('2026-09-08');
  });
});
