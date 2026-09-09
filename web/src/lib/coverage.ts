import type { Analysis } from './api/types.js';

/**
 * Представление полноты анализа.
 *
 * Здесь только форматирование уже вычисленных значений. Собственной оценки
 * качества анализа фронтенд не выводит: доля и статус снимка приходят с
 * бэкенда, где они посчитаны на этапе анализа.
 */

/** Русское форматирование числа с разделением разрядов. */
export function formatCount(value: number): string {
  return value.toLocaleString('ru-RU');
}

/**
 * Доля проанализированных отзывов в процентах.
 *
 * Возвращает null, если общее количество неизвестно: доля от неизвестного
 * не имеет смысла, и придумывать её нельзя.
 */
export function coveragePercent(analysis: Analysis): number | null {
  if (analysis.totalAvailable === null || analysis.totalAvailable === 0) return null;
  return (analysis.analyzedCount / analysis.totalAvailable) * 100;
}

/**
 * Понятная пользователю строка о полноте.
 *
 * Например: «Проанализировано 200 из 6 595 отзывов (3,0%)».
 */
export function coverageMessage(analysis: Analysis): string {
  const analyzed = formatCount(analysis.analyzedCount);

  if (analysis.totalAvailable === null) {
    return `Проанализировано отзывов: ${analyzed}. Общее количество неизвестно`;
  }

  const total = formatCount(analysis.totalAvailable);
  const percent = coveragePercent(analysis);

  if (percent === null) {
    return `Проанализировано ${analyzed} из ${total} отзывов`;
  }

  // Одна цифра после запятой: доли процента здесь не информативны
  const formatted = percent.toLocaleString('ru-RU', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

  return `Проанализировано ${analyzed} из ${total} отзывов (${formatted}%)`;
}

/** Пояснение к состоянию снимка отзывов. */
export function snapshotMessage(analysis: Analysis): string | null {
  switch (analysis.snapshotCompleteness) {
    case 'partial':
      return 'Получена только часть отзывов источника — выводы могут быть неполными';
    case 'incomplete':
      return 'Сбор отзывов был прерван — выводы основаны на неполных данных';
    case 'complete':
      return null;
    default:
      return null;
  }
}

/**
 * Нужно ли предупредить, что выводы основаны на выборке.
 *
 * Скрывать это ради опрятности интерфейса нельзя: пользователь должен
 * понимать, что читает мнение не всех игроков.
 */
export function isPartialView(analysis: Analysis): boolean {
  return analysis.coverage === 'sample' || analysis.snapshotCompleteness !== 'complete';
}

const CONFIDENCE_LABELS: Record<'low' | 'medium' | 'high', string> = {
  low: 'низкая',
  medium: 'средняя',
  high: 'высокая',
};

export function confidenceLabel(analysis: Analysis): string | null {
  return analysis.confidence ? CONFIDENCE_LABELS[analysis.confidence] : null;
}

const STATUS_MESSAGES: Record<Analysis['status'], string | null> = {
  ok: null,
  insufficient_reviews: 'Отзывов слишком мало для содержательного анализа',
  failed: 'Анализ не удалось выполнить',
};

export function statusMessage(analysis: Analysis): string | null {
  return STATUS_MESSAGES[analysis.status];
}

/** Область действия оценки: объясняет, к чему она относится (ADR-0008). */
export function scopeNote(scope: string): string | null {
  switch (scope) {
    case 'overall':
      return 'Оценка по игре в целом, не по этой платформе';
    case 'overall_fallback':
      return 'Не удалось связать оценку с платформой; показана общая';
    case 'derived':
      return 'Расчётная оценка';
    case 'platform':
      return null;
    default:
      return null;
  }
}
