import {
  LlmError,
  type LlmAnalysisRequest,
  type LlmAnalysisResult,
  type LlmProvider,
} from '../domain/llm-provider.js';

/**
 * Провайдер-заглушка для тестов.
 *
 * Реальные сетевые вызовы в обычном прогоне запрещены (ADR-0006): тесты
 * должны быть бесплатными, быстрыми и детерминированными.
 *
 * Формирует осмысленный ответ из переданных отзывов, поэтому проверки
 * ссылок на свидетельства работают по-настоящему.
 */
export interface FakeLlmProviderOptions {
  readonly model?: string;
  /** Заставляет провайдер бросить заданную ошибку. */
  readonly failWith?: LlmError;
  /** Возвращает сырой ответ вместо сгенерированного — для проверки валидации. */
  readonly rawResponse?: string;
  /** Число неудач перед успехом — для проверки повторов. */
  readonly failTimes?: number;
  readonly usage?: { inputTokens: number | null; outputTokens: number | null };
}

export class FakeLlmProvider implements LlmProvider {
  readonly model: string;
  readonly requests: LlmAnalysisRequest[] = [];

  private remainingFailures: number;

  constructor(private readonly options: FakeLlmProviderOptions = {}) {
    this.model = options.model ?? 'fake-model-v1';
    this.remainingFailures = options.failTimes ?? 0;
  }

  get callCount(): number {
    return this.requests.length;
  }

  async analyzeReviews(request: LlmAnalysisRequest): Promise<LlmAnalysisResult> {
    this.requests.push(request);

    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new LlmError('server_error', 'Временный сбой провайдера (заглушка)');
    }

    if (this.options.failWith) throw this.options.failWith;

    if (this.options.rawResponse !== undefined) {
      // Сырой ответ проходит тот же путь проверки, что и настоящий.
      return parseFakeRaw(this.options.rawResponse, this.model, this.options.usage);
    }

    const refs = request.reviews.map((review) => review.ref);
    const positive = request.reviews.filter((r) => (r.score ?? 0) >= (request.kind === 'critic' ? 75 : 7));
    const negative = request.reviews.filter((r) => (r.score ?? 99) <= (request.kind === 'critic' ? 49 : 3));

    return {
      model: this.model,
      usage: this.options.usage ?? { inputTokens: 1000, outputTokens: 200 },
      content: {
        summary: `Анализ ${request.reviews.length} отзывов об игре ${request.gameTitle}.`,
        liked:
          positive.length > 0
            ? [
                {
                  text: 'Положительные отклики',
                  evidenceRefs: positive.slice(0, 3).map((r) => r.ref),
                },
              ]
            : [],
        disliked:
          negative.length > 0
            ? [
                {
                  text: 'Отрицательные отклики',
                  evidenceRefs: negative.slice(0, 3).map((r) => r.ref),
                },
              ]
            : [],
        themes:
          refs.length > 0
            ? [
                {
                  name: 'общее впечатление',
                  sentiment: 'mixed' as const,
                  description: 'Сводная тема, построенная заглушкой',
                  evidenceRefs: refs.slice(0, 2),
                },
              ]
            : [],
        confidence: refs.length >= 10 ? ('high' as const) : ('low' as const),
      },
    };
  }
}

function parseFakeRaw(
  raw: string,
  model: string,
  usage: FakeLlmProviderOptions['usage'],
): LlmAnalysisResult {
  // Заглушка не проверяет ответ сама: это делает вызывающий код, и тест
  // должен видеть настоящий путь проверки.
  const parsed = JSON.parse(raw) as LlmAnalysisResult['content'];
  return {
    model,
    usage: usage ?? { inputTokens: null, outputTokens: null },
    content: parsed,
  };
}
