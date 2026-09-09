import { describe, expect, it } from 'vitest';
import {
  hasExhaustedAttempts,
  isCriticalStage,
  isLeaseExpired,
  nextStage,
  resolveProcessingDay,
  shouldRunStage,
  type DailyClaim,
  type StageMap,
} from '../../src/modules/ingestion/domain/claim.js';

/**
 * Доменные тесты выполняются без БД и без сети (ADR-0001).
 */

function makeClaim(overrides: Partial<DailyClaim> = {}): DailyClaim {
  return {
    processingDay: '2026-09-07',
    source: 'metacritic',
    sourceSlug: 'elden-ring',
    gameId: null,
    runId: null,
    status: 'claimed',
    claimedAt: new Date('2026-09-07T10:00:00Z'),
    leaseUntil: new Date('2026-09-07T10:10:00Z'),
    attempts: 1,
    stages: {},
    lastError: null,
    completedAt: null,
    ...overrides,
  };
}

describe('resolveProcessingDay', () => {
  it('вычисляет день по UTC, а не по времени сервера', () => {
    // 23:30 UTC — в положительных зонах это уже следующий день
    const at = new Date('2026-09-07T23:30:00Z');
    expect(resolveProcessingDay(at, 'UTC')).toBe('2026-09-07');
  });

  it('учитывает конфигурируемую таймзону', () => {
    const at = new Date('2026-09-07T23:30:00Z');
    // В Токио (UTC+9) это уже 8 сентября
    expect(resolveProcessingDay(at, 'Asia/Tokyo')).toBe('2026-09-08');
  });

  it('корректно обрабатывает границу суток', () => {
    expect(resolveProcessingDay(new Date('2026-09-07T00:00:00Z'), 'UTC')).toBe('2026-09-07');
    expect(resolveProcessingDay(new Date('2026-09-07T23:59:59Z'), 'UTC')).toBe('2026-09-07');
    expect(resolveProcessingDay(new Date('2026-09-08T00:00:00Z'), 'UTC')).toBe('2026-09-08');
  });
});

describe('shouldRunStage — возобновление частично выполненной работы', () => {
  it('выполняет стадию, о которой ещё нет записи', () => {
    expect(shouldRunStage({}, 'fetchGame')).toBe(true);
  });

  it('НЕ повторяет уже завершённую стадию', () => {
    const stages: StageMap = { fetchGame: { status: 'done' } };
    expect(shouldRunStage(stages, 'fetchGame')).toBe(false);
  });

  it('НЕ повторяет намеренно пропущенную стадию', () => {
    const stages: StageMap = {
      youtube: { status: 'skipped', reason: 'feature_disabled' },
    };
    expect(shouldRunStage(stages, 'youtube')).toBe(false);
  });

  it('повторяет упавшую стадию', () => {
    const stages: StageMap = { summarize: { status: 'failed', error: 'timeout' } };
    expect(shouldRunStage(stages, 'summarize')).toBe(true);
  });
});

describe('nextStage', () => {
  const order = ['fetchGame', 'fetchReviews', 'summarize'] as const;

  it('возвращает первую незавершённую стадию', () => {
    const stages: StageMap = {
      fetchGame: { status: 'done' },
      fetchReviews: { status: 'done' },
    };
    expect(nextStage(stages, order)).toBe('summarize');
  });

  it('возвращает null, когда всё выполнено', () => {
    const stages: StageMap = {
      fetchGame: { status: 'done' },
      fetchReviews: { status: 'done' },
      summarize: { status: 'done' },
    };
    expect(nextStage(stages, order)).toBeNull();
  });

  it('после перезапуска продолжает с нужного места, а не с начала', () => {
    const stages: StageMap = { fetchGame: { status: 'done' } };
    expect(nextStage(stages, order)).toBe('fetchReviews');
  });
});

describe('isCriticalStage — изоляция сбоев обогащения', () => {
  it('стадии получения данных критичны', () => {
    expect(isCriticalStage('fetchGame')).toBe(true);
    expect(isCriticalStage('fetchReviews')).toBe(true);
  });

  it('обогащающие стадии не критичны и не должны ронять обработку игры', () => {
    expect(isCriticalStage('summarize')).toBe(false);
    expect(isCriticalStage('similar')).toBe(false);
    expect(isCriticalStage('youtube')).toBe(false);
  });
});

describe('isLeaseExpired — обнаружение упавшего воркера', () => {
  const now = new Date('2026-09-07T10:15:00Z');

  it('аренда истекла', () => {
    const claim = makeClaim({ leaseUntil: new Date('2026-09-07T10:10:00Z') });
    expect(isLeaseExpired(claim, now)).toBe(true);
  });

  it('аренда ещё действует', () => {
    const claim = makeClaim({ leaseUntil: new Date('2026-09-07T10:20:00Z') });
    expect(isLeaseExpired(claim, now)).toBe(false);
  });

  it('завершённая заявка не считается протухшей', () => {
    const claim = makeClaim({
      status: 'done',
      leaseUntil: null,
      completedAt: new Date('2026-09-07T10:05:00Z'),
    });
    expect(isLeaseExpired(claim, now)).toBe(false);
  });
});

describe('hasExhaustedAttempts', () => {
  it('останавливает повторы при достижении предела', () => {
    expect(hasExhaustedAttempts(3, 3)).toBe(true);
    expect(hasExhaustedAttempts(2, 3)).toBe(false);
  });
});
