'use server';

import { revalidatePath } from 'next/cache';
import { triggerRun } from '@/lib/api/client';

/**
 * Ручной запуск обработки.
 *
 * Серверное действие: админ-токен читается из окружения на сервере и в
 * браузер не передаётся. Клиент вызывает действие, не зная ни адреса
 * бэкенда, ни токена.
 */

export interface TriggerState {
  readonly kind: 'idle' | 'started' | 'busy' | 'error';
  readonly message: string;
}

export async function startProcessing(): Promise<TriggerState> {
  const outcome = await triggerRun();

  if (outcome.status === 202 && outcome.result) {
    revalidatePath('/monitoring');
    const { processed, failed, claimed } = outcome.result;
    return {
      kind: 'started',
      message: `Обработка завершена: взято ${claimed}, обработано ${processed}, с ошибками ${failed}`,
    };
  }

  // 409 — запуск уже идёт. Это состояние, а не сбой.
  if (outcome.status === 409) {
    return {
      kind: 'busy',
      message: 'Обработка уже выполняется — второй запуск не создан',
    };
  }

  return {
    kind: 'error',
    message: outcome.message ?? 'Не удалось запустить обработку',
  };
}
