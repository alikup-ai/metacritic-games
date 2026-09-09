import type { UnitOfWork } from '../../catalog/domain/unit-of-work.js';
import type { ReviewKind, StoredReview } from '../../reviews/domain/review.js';
import type { ReviewRepository, ReviewSnapshotRepository } from '../../reviews/domain/review-ports.js';
import {
  isLlmError,
  LlmError,
  type LlmProvider,
  type PreparedReview,
} from '../domain/llm-provider.js';
import type { ReviewSummary, ReviewSummaryRepository, SummaryStatus } from '../domain/summary.js';
import {
  noopAnalysisEventSink,
  type AnalysisEventSink,
} from '../domain/analysis-events.js';
import { computeInputHash } from './input-hash.js';
import { validateEvidenceContent } from './validate-output.js';
import { selectReviewsForAnalysis, type SelectionLimits } from './select-reviews.js';

/**
 * Анализ отзывов одного типа для одной игры.
 *
 * Порядок (ADR-0013):
 *   1) отбор из УЖЕ СОХРАНЁННЫХ отзывов — детерминированный;
 *   2) сравнение входного хеша: совпал — вызова нет;
 *   3) вызов модели ВНЕ транзакции, с ограниченными повторами;
 *   4) проверка схемы и ссылок на свидетельства;
 *   5) транзакция: сохранение резюме.
 *
 * Сбой анализа НЕ затрагивает сохранённые отзывы: это отдельная,
 * обогащающая стадия.
 */

export interface AnalyzeReviewsDeps {
  readonly provider: LlmProvider;
  readonly reviews: ReviewRepository;
  readonly snapshots: ReviewSnapshotRepository;
  readonly summaries: ReviewSummaryRepository;
  readonly unitOfWork: UnitOfWork;
  readonly events?: AnalysisEventSink;
  readonly hash: (input: string) => string;
  readonly limits: SelectionLimits;
  readonly promptVersion: string;
  readonly samplingVersion: string;
  readonly minReviews: number;
  readonly retryCount: number;
  readonly maxOutputTokens: number;
  /** Задержка между повторами; подменяется в тестах. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
}

export interface AnalyzeReviewsParams {
  readonly gameId: string;
  readonly gameTitle: string;
  readonly kind: ReviewKind;
  readonly platformSlug: string;
  readonly signal?: AbortSignal;
}

export interface AnalyzeReviewsResult {
  readonly status: SummaryStatus | 'skipped';
  readonly analyzedCount: number;
  readonly coverage: string | null;
  readonly inputHash: string | null;
  readonly attempts: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class AnalyzeReviewsUseCase {
  private readonly events: AnalysisEventSink;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(private readonly deps: AnalyzeReviewsDeps) {
    this.events = deps.events ?? noopAnalysisEventSink;
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? (() => new Date());
  }

  async execute(params: AnalyzeReviewsParams): Promise<AnalyzeReviewsResult> {
    const startedAt = Date.now();
    const base = {
      gameId: params.gameId,
      kind: params.kind,
      platformSlug: params.platformSlug,
      model: this.deps.provider.model,
      promptVersion: this.deps.promptVersion,
      samplingVersion: this.deps.samplingVersion,
    };

    const snapshot = await this.deps.snapshots.find({
      gameId: params.gameId,
      kind: params.kind,
      platformSlug: params.platformSlug,
    });

    const stored = await this.deps.reviews.findByGame({
      gameId: params.gameId,
      kind: params.kind,
      platformSlug: params.platformSlug,
    });

    // Ниже порога анализ бессмысленен: из одного-двух отзывов не выйдет
    // статистически осмысленного вывода, а токены будут потрачены.
    if (stored.length < this.deps.minReviews) {
      await this.persistNonOk(params, snapshot, 'insufficient_reviews', null, null);

      this.events.emit({
        type: 'llm_analysis_skipped',
        ...base,
        reason: 'insufficient_reviews',
        reviewCount: stored.length,
      });

      return {
        status: 'insufficient_reviews',
        analyzedCount: 0,
        coverage: null,
        inputHash: null,
        attempts: 0,
      };
    }

    const selection = selectReviewsForAnalysis(stored, params.kind, this.deps.limits);

    const inputHash = computeInputHash(
      {
        kind: params.kind,
        platformSlug: params.platformSlug,
        reviews: selection.reviews,
        promptVersion: this.deps.promptVersion,
        samplingVersion: this.deps.samplingVersion,
        model: this.deps.provider.model,
      },
      this.deps.hash,
    );

    // Кеш: тот же вход при успешном прошлом результате не требует вызова.
    // Неуспешные резюме не кешируются — иначе разовый сбой навсегда лишил
    // бы игру анализа.
    const existing = await this.deps.summaries.find({
      gameId: params.gameId,
      kind: params.kind,
      platformSlug: params.platformSlug,
    });

    if (existing && existing.status === 'ok' && existing.inputHash === inputHash) {
      this.events.emit({
        type: 'llm_analysis_skipped',
        ...base,
        reason: 'input_unchanged',
        reviewCount: selection.analyzedCount,
      });

      return {
        status: 'skipped',
        analyzedCount: existing.analyzedCount,
        coverage: existing.coverage,
        inputHash,
        attempts: 0,
      };
    }

    this.events.emit({
      type: 'llm_analysis_started',
      ...base,
      inputCount: selection.analyzedCount,
      coverage: selection.coverage,
    });

    // --- Вызов модели вне транзакции
    const totalAvailable = snapshot?.totalAvailable ?? stored.length;
    let attempts = 0;

    try {
      const result = await this.callWithRetry(
        {
          kind: params.kind,
          gameTitle: params.gameTitle,
          platformSlug: params.platformSlug,
          reviews: selection.reviews,
          analyzedCount: selection.analyzedCount,
          totalAvailable,
          promptVersion: this.deps.promptVersion,
          samplingVersion: this.deps.samplingVersion,
          maxOutputTokens: this.deps.maxOutputTokens,
          ...(params.signal ? { signal: params.signal } : {}),
        },
        (count) => {
          attempts = count;
        },
      );

      const summary: ReviewSummary = {
        gameId: params.gameId,
        kind: params.kind,
        platformSlug: params.platformSlug,
        status: 'ok',
        summary: result.content.summary,
        liked: result.content.liked,
        disliked: result.content.disliked,
        themes: result.content.themes,
        confidence: result.content.confidence,
        inputHash,
        sourceFingerprint: snapshot?.fingerprint ?? '',
        // Фактическая модель из ответа, а не запрошенная.
        model: result.model,
        promptVersion: this.deps.promptVersion,
        samplingVersion: this.deps.samplingVersion,
        // Достоверные поля берутся из НАШИХ данных, не из ответа модели.
        analyzedCount: selection.analyzedCount,
        totalAvailable,
        snapshotCompleteness: snapshot?.completeness ?? null,
        coverage: selection.coverage,
        tokensIn: result.usage.inputTokens,
        tokensOut: result.usage.outputTokens,
        lastError: null,
        errorCategory: null,
        generatedAt: this.now(),
      };

      await this.deps.unitOfWork.withTransaction(async (tx) => {
        await this.deps.summaries.save(summary, tx);
      });

      this.events.emit({
        type: 'llm_analysis_completed',
        ...base,
        inputCount: selection.analyzedCount,
        coverage: selection.coverage,
        confidence: result.content.confidence,
        tokensIn: result.usage.inputTokens,
        tokensOut: result.usage.outputTokens,
        durationMs: Date.now() - startedAt,
        attempts,
      });

      return {
        status: 'ok',
        analyzedCount: selection.analyzedCount,
        coverage: selection.coverage,
        inputHash,
        attempts,
      };
    } catch (error) {
      const category = isLlmError(error) ? error.category : 'unknown';
      const message = error instanceof Error ? error.message : String(error);

      // Отзывы остаются нетронутыми: пишется только запись о неудаче.
      await this.persistNonOk(params, snapshot, 'failed', message, category);

      this.events.emit({
        type: 'llm_analysis_failed',
        ...base,
        errorCategory: category,
        errorMessage: message,
        durationMs: Date.now() - startedAt,
        attempts,
      });

      return {
        status: 'failed',
        analyzedCount: selection.analyzedCount,
        coverage: selection.coverage,
        inputHash: null,
        attempts,
      };
    }
  }

  /**
   * Вызов с ограниченными повторами.
   *
   * Повторяются только транзиентные сбои. Невалидный ответ повторяется
   * ОДИН раз: модель может исправиться, но настойчивые повторы лишь
   * умножают расход без роста шансов.
   */
  private async callWithRetry(
    request: Parameters<LlmProvider['analyzeReviews']>[0],
    onAttempt: (count: number) => void,
  ): Promise<Awaited<ReturnType<LlmProvider['analyzeReviews']>>> {
    const maxAttempts = Math.max(1, this.deps.retryCount + 1);
    let lastError: unknown;
    let validationRetried = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      onAttempt(attempt);

      try {
        const result = await this.deps.provider.analyzeReviews(request);

        // Ссылки проверяются ЗДЕСЬ, а не только в адаптере: use case —
        // единственное место, которое достоверно знает, какие отзывы были
        // отправлены. Иначе гарантия держалась бы на дисциплине каждой
        // реализации порта, и адаптер без проверки записал бы галлюцинацию.
        validateEvidenceContent(result.content, request.reviews);

        return result;
      } catch (error) {
        lastError = error;

        if (!isLlmError(error)) throw error;

        // Отмена и превышение лимита токенов повтором не лечатся.
        if (error.category === 'aborted' || error.category === 'token_limit') throw error;

        const isValidation =
          error.category === 'malformed_json' ||
          error.category === 'schema_invalid' ||
          error.category === 'evidence_invalid';

        if (isValidation) {
          if (validationRetried) throw error;
          validationRetried = true;
          continue;
        }

        if (!error.retryable || attempt >= maxAttempts) throw error;

        // Провайдер мог указать задержку — она приоритетнее экспоненты.
        const delay = error.retryAfterMs ?? 500 * 2 ** (attempt - 1);
        await this.sleep(delay);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new LlmError('unavailable', 'Вызов модели не выполнен');
  }

  /** Записывает резюме без содержимого: недостаточно данных либо сбой. */
  private async persistNonOk(
    params: AnalyzeReviewsParams,
    snapshot: { fingerprint: string; totalAvailable: number | null; completeness: string } | null,
    status: SummaryStatus,
    message: string | null,
    category: string | null,
  ): Promise<void> {
    const summary: ReviewSummary = {
      gameId: params.gameId,
      kind: params.kind,
      platformSlug: params.platformSlug,
      status,
      summary: null,
      liked: [],
      disliked: [],
      themes: [],
      confidence: null,
      // Хеш не сохраняется: неуспех не должен блокировать повтор.
      inputHash: null,
      sourceFingerprint: snapshot?.fingerprint ?? '',
      model: this.deps.provider.model,
      promptVersion: this.deps.promptVersion,
      samplingVersion: this.deps.samplingVersion,
      analyzedCount: 0,
      totalAvailable: snapshot?.totalAvailable ?? null,
      snapshotCompleteness:
        (snapshot?.completeness as ReviewSummary['snapshotCompleteness']) ?? null,
      coverage: null,
      tokensIn: null,
      tokensOut: null,
      lastError: message ? message.slice(0, 2000) : null,
      errorCategory: category,
      generatedAt: this.now(),
    };

    await this.deps.unitOfWork
      .withTransaction(async (tx) => {
        await this.deps.summaries.save(summary, tx);
      })
      .catch(() => undefined);
  }
}

export type { PreparedReview, StoredReview };
