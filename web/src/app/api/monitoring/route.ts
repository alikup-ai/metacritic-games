import { NextResponse } from 'next/server';
import { fetchRuns, fetchWorkers } from '@/lib/api/client';

/**
 * Данные мониторинга для периодического опроса из браузера.
 *
 * Обращение к бэкенду выполняется здесь, на сервере: адрес API и
 * админ-токен в браузер не попадают.
 *
 * Один маршрут вместо двух: интерфейсу нужны обе части одновременно,
 * и лишний запрос ничего не даёт.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    const [workers, runs] = await Promise.all([fetchWorkers(), fetchRuns(20)]);

    return NextResponse.json(
      { workers: workers.items, runs: runs.items, fetchedAt: new Date().toISOString() },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    // Подробности сбоя наружу не отдаём: адрес бэкенда клиенту не нужен
    return NextResponse.json(
      { error: 'Данные мониторинга недоступны' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
