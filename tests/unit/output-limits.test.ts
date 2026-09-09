import { describe, expect, it } from 'vitest';
import {
  parseAnalysisOutput,
  validateEvidence,
} from '../../src/modules/analysis/application/validate-output.js';
import { LlmError } from '../../src/modules/analysis/domain/llm-provider.js';
import type { PreparedReview } from '../../src/modules/analysis/domain/llm-provider.js';

/**
 * Пределы схемы ответа.
 *
 * Значения подобраны по РЕАЛЬНЫМ ответам модели, а не назначены
 * умозрительно: измеренные успешные резюме занимают 400-790 символов,
 * отклонённые превышали прежний предел на 10-20 % и были при этом
 * содержательно корректны.
 *
 * Задача пределов — отсекать чрезмерное, а не корректное.
 */

function point(text: string, refs = 1): { text: string; evidenceRefs: string[] } {
  return {
    text,
    evidenceRefs: Array.from({ length: refs }, (_, i) => `r${i + 1}`),
  };
}

function theme(refs = 1): Record<string, unknown> {
  return {
    name: 'тема',
    sentiment: 'mixed',
    description: 'описание темы',
    evidenceRefs: Array.from({ length: refs }, (_, i) => `r${i + 1}`),
  };
}

function output(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    summary: 'Резюме анализа отзывов достаточной длины для проверки схемы.',
    liked: [point('Хорошая боевая система')],
    disliked: [point('Технические проблемы')],
    themes: [theme()],
    confidence: 'medium',
    ...overrides,
  });
}

function prepared(count: number): PreparedReview[] {
  return Array.from({ length: count }, (_, i) => ({
    ref: `r${i + 1}`,
    reviewKey: `user:u${i + 1}`,
    score: 8,
    date: '2026-01-01',
    text: 'текст',
    truncated: false,
    duplicates: 1,
    source: 'user' as const,
  }));
}

describe('Обычный ответ', () => {
  it('типичный ответ принимается', () => {
    expect(() => parseAnalysisOutput(output())).not.toThrow();
  });

  it('измеренная типичная длина резюме проходит', () => {
    // Успешные ответы занимали 400-790 символов
    expect(() => parseAnalysisOutput(output({ summary: 'а'.repeat(790) }))).not.toThrow();
  });
});

describe('Ответ на границе предела', () => {
  it('резюме ровно в предел принимается', () => {
    expect(() => parseAnalysisOutput(output({ summary: 'а'.repeat(2500) }))).not.toThrow();
  });

  it('20 пунктов ровно в предел принимаются', () => {
    const items = Array.from({ length: 20 }, (_, i) => point(`пункт ${i}`));
    expect(() => parseAnalysisOutput(output({ liked: items }))).not.toThrow();
  });

  it('16 ссылок ровно в предел принимаются', () => {
    expect(() => parseAnalysisOutput(output({ liked: [point('пункт', 16)] }))).not.toThrow();
  });
});

describe('Корректный ответ выше ПРЕЖНИХ пределов', () => {
  it('резюме 1756 символов принимается (прежний предел 1500 отвергал)', () => {
    // Реальный случай: Star Wars Zero Company [critic]
    expect(() => parseAnalysisOutput(output({ summary: 'а'.repeat(1756) }))).not.toThrow();
  });

  it('17 пунктов disliked принимаются (прежний предел 15 отвергал)', () => {
    // Реальный случай: MLB The Show 26 [user]
    const items = Array.from({ length: 17 }, (_, i) => point(`недостаток ${i}`));
    expect(() => parseAnalysisOutput(output({ disliked: items }))).not.toThrow();
  });

  it('11 ссылок принимаются (прежний предел 10 отвергал)', () => {
    expect(() => parseAnalysisOutput(output({ liked: [point('пункт', 11)] }))).not.toThrow();
  });

  it('16 тем принимаются (прежний предел 15 отвергал)', () => {
    const items = Array.from({ length: 16 }, () => theme());
    expect(() => parseAnalysisOutput(output({ themes: items }))).not.toThrow();
  });
});

describe('Действительно чрезмерный ответ', () => {
  it('резюме втрое выше предела отвергается', () => {
    // Пересказ отзывов вместо резюме — предел обязан сработать
    expect(() => parseAnalysisOutput(output({ summary: 'а'.repeat(7500) }))).toThrow(LlmError);
  });

  it('50 пунктов отвергаются', () => {
    const items = Array.from({ length: 50 }, (_, i) => point(`пункт ${i}`));
    expect(() => parseAnalysisOutput(output({ liked: items }))).toThrow(LlmError);
  });

  it('перечисление всей выборки в ссылках отвергается', () => {
    expect(() => parseAnalysisOutput(output({ liked: [point('пункт', 60)] }))).toThrow(LlmError);
  });

  it('слишком длинный текст пункта отвергается', () => {
    expect(() => parseAnalysisOutput(output({ liked: [point('а'.repeat(500))] }))).toThrow(
      LlmError,
    );
  });

  it('сообщение об ошибке не содержит текста ответа', () => {
    const marker = 'СОДЕРЖИМОЕ_ОТВЕТА_12345';
    try {
      parseAnalysisOutput(output({ summary: marker + 'а'.repeat(7500) }));
      expect.unreachable('должно было выбросить');
    } catch (error) {
      expect((error as Error).message).not.toContain(marker);
    }
  });
});

describe('Некорректный ответ', () => {
  it('невалидный JSON даёт malformed_json', () => {
    try {
      parseAnalysisOutput('{ сломанный');
      expect.unreachable('должно было выбросить');
    } catch (error) {
      expect((error as LlmError).category).toBe('malformed_json');
    }
  });

  it('пустое резюме отвергается', () => {
    expect(() => parseAnalysisOutput(output({ summary: '' }))).toThrow(LlmError);
  });

  it('пункт без ссылок отвергается', () => {
    expect(() =>
      parseAnalysisOutput(output({ liked: [{ text: 'пункт', evidenceRefs: [] }] })),
    ).toThrow(LlmError);
  });

  it('лишние поля отвергаются', () => {
    expect(() => parseAnalysisOutput(output({ extraField: 'нечто' }))).toThrow(LlmError);
  });
});

describe('Ссылки на свидетельства', () => {
  it('ссылка вне переданной выборки отвергается', () => {
    const parsed = parseAnalysisOutput(output({ liked: [point('пункт', 5)] }));
    try {
      // Передано только 3 отзыва, а ссылок 5
      validateEvidence(parsed, prepared(3));
      expect.unreachable('должно было выбросить');
    } catch (error) {
      expect((error as LlmError).category).toBe('evidence_invalid');
    }
  });

  it('ссылки внутри выборки проходят', () => {
    const parsed = parseAnalysisOutput(output({ liked: [point('пункт', 5)] }));
    expect(() => validateEvidence(parsed, prepared(10))).not.toThrow();
  });

  it('ослабление предела не ослабило проверку ссылок', () => {
    // 16 ссылок допустимы схемой, но должны существовать в выборке
    const parsed = parseAnalysisOutput(output({ liked: [point('пункт', 16)] }));
    expect(() => validateEvidence(parsed, prepared(16))).not.toThrow();
    expect(() => validateEvidence(parsed, prepared(15))).toThrow(LlmError);
  });
});
