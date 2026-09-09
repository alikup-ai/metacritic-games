// Схема объявляется через zod/v4: именно этот тип принимает zodOutputFormat
// из SDK. Импорт из корня 'zod' даёт несовместимый тип v3.
import { z } from 'zod/v4';
import {
  LlmError,
  type AnalysisPoint,
  type LlmAnalysisContent,
  type PreparedReview,
} from '../domain/llm-provider.js';

/**
 * Проверка ответа модели.
 *
 * Вывод модели остаётся НЕДОВЕРЕННЫМ даже после разбора: схема ограничивает
 * его форму, но не гарантирует правдивость. Поэтому проверок две ступени —
 * структура и ссылки на свидетельства.
 *
 * Схема объявлена в ОДНОМ месте и переиспользуется провайдером: дублирование
 * привело бы к расхождению между тем, что просим, и тем, что принимаем.
 */

const evidenceRefSchema = z
  .string()
  .regex(/^r\d+$/, 'Ссылка должна иметь вид r<номер>');

const pointSchema = z.object({
  text: z.string().min(1).max(300),
  // 16, а не 10: модель приводит все подтверждающие отзывы, и при
  // выборке в 50-60 штук их закономерно больше десяти. Ограничение
  // защищает от вырождения списка в перечисление всей выборки.
  evidenceRefs: z.array(evidenceRefSchema).min(1).max(16),
});

const themeSchema = z.object({
  name: z.string().min(1).max(80),
  sentiment: z.enum(['positive', 'negative', 'neutral', 'mixed']),
  description: z.string().min(1).max(400),
  evidenceRefs: z.array(evidenceRefSchema).min(1).max(16),
});

/** Схема ответа. Единственный источник истины о его форме. */
export const analysisOutputSchema = z
  .object({
    // Пределы измерены на реальных ответах, а не назначены умозрительно.
    //
    // Успешные резюме укладываются в 400-790 символов; отклонённые
    // превышали предел на 10-20 % (например, 1756 при пределе 1500) и
    // при этом были содержательно корректны — модель не считает символы
    // точно, сколь угодно строго это ни требовать промптом.
    //
    // 2500 — примерно втрое больше типичного ответа: корректный текст
    // проходит, а действительно раздутый (пересказ отзывов вместо
    // резюме) по-прежнему отвергается.
    summary: z.string().min(10).max(2500),
    // 20 вместо 15: при выборке в 50-60 отзывов модель устойчиво
    // упирается в предел, то есть он отсекал содержательные пункты.
    liked: z.array(pointSchema).max(20),
    disliked: z.array(pointSchema).max(20),
    themes: z.array(themeSchema).max(20),
    confidence: z.enum(['low', 'medium', 'high']),
  })
  // Лишние поля отклоняются: модель не должна расширять контракт.
  .strict();

export type ValidatedOutput = z.infer<typeof analysisOutputSchema>;

// JSON Schema отдельно НЕ объявляется: zodOutputFormat выводит её из
// analysisOutputSchema. Ручная копия разошлась бы с zod-схемой незаметно —
// мы просили бы одно, а принимали другое.

/**
 * Разбирает и проверяет ответ по схеме.
 * Бросает типизированную ошибку, а не возвращает частичный результат.
 */
export function parseAnalysisOutput(raw: string): ValidatedOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new LlmError('malformed_json', 'Ответ модели не является корректным JSON', {
      cause: error,
    });
  }

  const result = analysisOutputSchema.safeParse(parsed);
  if (!result.success) {
    // В сообщение попадают только пути и коды — не содержимое ответа.
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`)
      .join('; ');
    throw new LlmError('schema_invalid', `Ответ модели не соответствует схеме: ${issues}`);
  }

  return result.data;
}

/**
 * Проверяет, что все ссылки указывают на реально переданные отзывы.
 *
 * Ссылка на несуществующий отзыв — прямой признак галлюцинации: модель
 * сослалась на то, чего не видела. Такой результат сохранять нельзя.
 */
export function validateEvidence(
  output: ValidatedOutput,
  reviews: readonly PreparedReview[],
): void {
  validateEvidenceContent(output, reviews);
}

/**
 * Та же проверка для уже приведённого к доменному виду результата.
 *
 * Нужна отдельно, потому что use case проверяет ответ ЛЮБОГО провайдера,
 * а не только того, который сам разбирал JSON.
 */
export function validateEvidenceContent(
  output: {
    readonly liked: readonly { readonly evidenceRefs: readonly string[] }[];
    readonly disliked: readonly { readonly evidenceRefs: readonly string[] }[];
    readonly themes: readonly { readonly evidenceRefs: readonly string[] }[];
  },
  reviews: readonly PreparedReview[],
): void {
  const known = new Set(reviews.map((review) => review.ref));

  const collect = (refs: readonly string[], where: string): string[] =>
    refs.filter((ref) => !known.has(ref)).map((ref) => `${where}:${ref}`);

  const unknown: string[] = [
    ...output.liked.flatMap((point) => collect(point.evidenceRefs, 'liked')),
    ...output.disliked.flatMap((point) => collect(point.evidenceRefs, 'disliked')),
    ...output.themes.flatMap((theme) => collect(theme.evidenceRefs, 'theme')),
  ];

  if (unknown.length > 0) {
    throw new LlmError(
      'evidence_invalid',
      `Ответ ссылается на отсутствующие отзывы: ${unknown.slice(0, 5).join(', ')}`,
    );
  }
}

/**
 * Приводит проверенный ответ к доменному виду.
 *
 * Поля, которые мы знаем достоверно (число отзывов, покрытие), сюда не
 * входят: они берутся из наших данных, а не из ответа модели.
 */
export function toAnalysisContent(output: ValidatedOutput): LlmAnalysisContent {
  const mapPoints = (points: ValidatedOutput['liked']): AnalysisPoint[] =>
    points.map((point) => ({ text: point.text, evidenceRefs: point.evidenceRefs }));

  return {
    summary: output.summary,
    liked: mapPoints(output.liked),
    disliked: mapPoints(output.disliked),
    themes: output.themes.map((theme) => ({
      name: theme.name,
      sentiment: theme.sentiment,
      description: theme.description,
      evidenceRefs: theme.evidenceRefs,
    })),
    // Уверенность понижается, если модель заявила высокую при отсутствии
    // содержательных выводов: это внутреннее противоречие.
    confidence:
      output.confidence === 'high' &&
      output.liked.length === 0 &&
      output.disliked.length === 0
        ? 'medium'
        : output.confidence,
  };
}
