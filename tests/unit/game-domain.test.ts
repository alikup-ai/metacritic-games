import { describe, expect, it } from 'vitest';
import { assertDeveloperConsistency } from '../../src/modules/catalog/domain/game.js';
import { loadConfig } from '../../src/shared/config/index.js';

describe('assertDeveloperConsistency — запрет подмены разработчика (ADR-0003)', () => {
  it('пропускает корректно определённого разработчика', () => {
    expect(() =>
      assertDeveloperConsistency({ developer: 'From Software', developerStatus: 'resolved' }),
    ).not.toThrow();
  });

  it('пропускает честно неизвестного разработчика', () => {
    // Подтверждённый реальный случай: игра без developer в разметке
    expect(() =>
      assertDeveloperConsistency({ developer: null, developerStatus: 'unknown' }),
    ).not.toThrow();
  });

  it('запрещает объявить разработчика определённым без значения', () => {
    expect(() =>
      assertDeveloperConsistency({ developer: null, developerStatus: 'resolved' }),
    ).toThrow(/подмена разработчика издателем запрещена/i);
  });

  it('запрещает пустую строку в качестве определённого разработчика', () => {
    expect(() =>
      assertDeveloperConsistency({ developer: '', developerStatus: 'resolved' }),
    ).toThrow();
  });
});

describe('loadConfig', () => {
  const validEnv = {
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  } as NodeJS.ProcessEnv;

  it('применяет значения по умолчанию', () => {
    const config = loadConfig(validEnv);
    expect(config.processingTimezone).toBe('UTC');
    expect(config.batchSize).toBe(20);
    expect(config.claimLeaseMinutes).toBe(10);
    expect(config.maxAttempts).toBe(3);
  });

  it('падает при отсутствии DATABASE_URL', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/Некорректная конфигурация/);
  });

  it('не раскрывает значения секретов в сообщении об ошибке', () => {
    const secret = 'postgres://admin:SUPER_SECRET_PASSWORD@host/db';
    try {
      loadConfig({ DATABASE_URL: 'не-url', LLM_API_KEY: secret } as NodeJS.ProcessEnv);
      expect.unreachable('должно было выбросить исключение');
    } catch (error) {
      expect(String(error)).not.toContain('SUPER_SECRET_PASSWORD');
    }
  });

  it('отвергает некорректные числовые значения', () => {
    expect(() =>
      loadConfig({ ...validEnv, BATCH_SIZE: '-5' } as NodeJS.ProcessEnv),
    ).toThrow();
  });
});
