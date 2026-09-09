import { z } from 'zod';

/**
 * Конфигурация приложения.
 *
 * Валидируется при старте: приложение падает сразу при неверных настройках,
 * а не в середине обработки батча.
 *
 * Секреты читаются только из environment и никогда не логируются
 * (ADR-0006, ADR-0007).
 */

const configSchema = z.object({
  databaseUrl: z.string().url('DATABASE_URL должен быть корректным URL'),

  // Обработка (ADR-0002, ADR-0004)
  processingTimezone: z.string().min(1).default('UTC'),
  batchSize: z.coerce.number().int().positive().default(20),
  workerConcurrency: z.coerce.number().int().positive().max(32).default(4),
  claimLeaseMinutes: z.coerce.number().int().positive().default(10),
  maxAttempts: z.coerce.number().int().positive().default(3),
  // Запасной критерий orphaned run (ADR-0010). Значение с запасом относительно
  // целевой длительности батча (<=10 мин): лучше не восстановить мёртвый запуск
  // сейчас, чем прервать живой.
  heartbeatTimeoutMinutes: z.coerce.number().int().positive().default(15),

  // --- Планировщик и воркеры (Phase 1C) ---
  // Выключен по умолчанию: включение запускает обращения к внешнему
  // источнику, и это должно быть осознанным решением.
  schedulerEnabled: z
    .enum(['true', 'false', '1', '0'])
    .transform((value) => value === 'true' || value === '1')
    .default('false'),
  // 60 минут — прямое требование ТЗ («1 раз в час»)
  schedulerIntervalMinutes: z.coerce.number().int().positive().default(60),
  // Аренда с запасом к целевой длительности батча (<=10 мин): лучше
  // задержать восстановление, чем забрать живую работу
  workerLeaseMinutes: z.coerce.number().int().positive().default(10),
  // Продление втрое чаще срока аренды: переживает пару пропущенных тиков
  workerHeartbeatIntervalSeconds: z.coerce.number().int().positive().default(180),
  // При 20 играх и ~24 карточках на странице хватает 2-3 страниц;
  // 25 — запас на случай, когда почти все кандидаты уже обработаны
  maxPagesPerRun: z.coerce.number().int().positive().default(25),
  // Три подряд бесполезные страницы означают, что источник исчерпан
  maxEmptyPages: z.coerce.number().int().positive().default(3),

  // --- Отзывы (Phase 1D) ---
  // Критический endpoint игнорирует limit и отдаёт 10; пользовательский
  // принимает до 200 (исследование 2026-09-08).
  reviewCriticPageSize: z.coerce.number().int().positive().max(200).default(10),
  reviewUserPageSize: z.coerce.number().int().positive().max(200).default(50),
  // Предел страниц на один обход: у критиков 93 отзыва = 10 страниц
  reviewMaxPages: z.coerce.number().int().positive().default(12),
  // Верхний предел числа отзывов; 0 = без ограничения (OQ-11)
  reviewMaxCritic: z.coerce.number().int().nonnegative().default(0),
  reviewMaxUser: z.coerce.number().int().nonnegative().default(50),

  // --- Анализ отзывов (Phase 2B). Шлюз: OpenRouter ---
  // Выключен по умолчанию: включение начинает тратить деньги
  llmEnabled: z
    .enum(['true', 'false', '1', '0'])
    .transform((value) => value === 'true' || value === '1')
    .default('false'),
  // Идентификатор модели в формате OpenRouter: <организация>/<модель>.
  // Значение задаётся конфигурацией; код от конкретной модели не зависит.
  llmModel: z.string().min(1).default('anthropic/claude-haiku-4.5'),
  // Ключ только из окружения; в код и логи не попадает.
  // Пустая строка — то же, что отсутствие (см. adminToken).
  llmApiKey: z
    .string()
    .transform((value) => (value.trim() === '' ? undefined : value))
    .optional(),
  // 60 отзывов ~ 23 тыс. символов при измеренной средней длине 384
  llmMaxReviews: z.coerce.number().int().positive().default(60),
  // Отсекает выброс в 4941 символ, сохраняя p90 = 723 целиком
  llmMaxReviewChars: z.coerce.number().int().positive().default(1200),
  llmMaxInputTokens: z.coerce.number().int().positive().default(20000),
  // 6000 подобрано по реальным ответам: при выборке в 60 отзывов и
  // пределах массивов в 15 пунктов ответ в 1500 токенов обрывался.
  llmMaxOutputTokens: z.coerce.number().int().positive().default(6000),
  // Анализ десятков отзывов заметно дольше обычного запроса
  llmTimeoutMs: z.coerce.number().int().positive().default(60000),
  llmRetryCount: z.coerce.number().int().nonnegative().default(2),
  // Ниже порога резюме статистически бессмысленно
  llmMinReviews: z.coerce.number().int().positive().default(3),
  llmPromptVersion: z.string().min(1).default('v1'),
  llmSamplingVersion: z.string().min(1).default('v1'),

  // HTTP
  metacriticRateLimitRps: z.coerce.number().positive().default(1),
  httpTimeoutMs: z.coerce.number().int().positive().default(15_000),
  metacriticUserAgent: z
    .string()
    .min(1)
    // HTTP-заголовки — ByteString: символы вне Latin-1 роняют fetch с TypeError.
    // Проверка по коду символа, а не регуляркой с управляющими символами.
    .refine(
      (value) => [...value].every((char) => char.charCodeAt(0) <= 0xff),
      'User-Agent должен содержать только символы Latin-1: HTTP-заголовки не допускают кириллицу',
    )
    .default('MetacriticGamesBot/0.1 (evaluation project; contact in repository)'),
  // Догрузка общего Userscore — отдельный HTTP-запрос на игру.
  // Выключено по умолчанию: удваивает нагрузку на источник.
  metacriticFetchUserscore: z
    .enum(['true', 'false', '1', '0'])
    .transform((value) => value === 'true' || value === '1')
    .default('false'),

  // --- Обогащение видеообзорами (ADR-0005) ---
  // Выключено по умолчанию: функция необязательная и требует ключа
  youtubeEnabled: z
    .enum(['true', 'false', '1', '0'])
    .transform((value) => value === 'true' || value === '1')
    .default('false'),
  // Ключ только из окружения; пустая строка равна отсутствию
  youtubeApiKey: z
    .string()
    .transform((value) => (value.trim() === '' ? undefined : value))
    .optional(),
  youtubeTimeoutMs: z.coerce.number().int().positive().default(10_000),
  youtubeMaxResults: z.coerce.number().int().positive().max(50).default(15),
  // Короче — клип без разбора; длиннее — полное прохождение
  youtubeMinDurationSeconds: z.coerce.number().int().positive().default(240),
  youtubeMaxDurationSeconds: z.coerce.number().int().positive().default(5400),
  youtubeMaxTranscriptChars: z.coerce.number().int().positive().default(24_000),
  // Внешний поставщик расшифровок. Ключ только из окружения;
  // пустая строка равна отсутствию. Без ключа поставщик не собирается,
  // и остаётся один timedtext.
  supadataApiKey: z
    .string()
    .transform((value) => (value.trim() === '' ? undefined : value))
    .optional(),
  supadataTimeoutMs: z.coerce.number().int().positive().default(30_000),
  /** Язык третьего приоритета после en и ru. */
  transcriptFallbackLanguage: z.string().optional(),

  // --- HTTP API (Phase 3A) ---
  apiPort: z.coerce.number().int().positive().max(65535).default(3001),
  apiHost: z.string().min(1).default('0.0.0.0'),
  // Токен ручного запуска (ADR-0007). Только из окружения; в логи и
  // ответы не попадает. Отсутствие означает, что POST /api/runs
  // недоступен — это безопаснее, чем открытый endpoint.
  // Пустая строка приравнивается к отсутствию: оркестраторы часто
  // подставляют "" вместо незаданной переменной, и это не должно
  // выглядеть как «задан пустой токен».
  adminToken: z
    .string()
    .transform((value) => (value.trim() === '' ? undefined : value))
    .optional(),
  // Ограничение частоты для защищённых операций (ADR-0007)
  apiRateLimitWindowMs: z.coerce.number().int().positive().default(60_000),
  apiRateLimitMax: z.coerce.number().int().positive().default(10),
  apiDefaultPageSize: z.coerce.number().int().positive().max(100).default(20),
  apiMaxPageSize: z.coerce.number().int().positive().max(100).default(100),

  // Пул подключений
  dbPoolMax: z.coerce.number().int().positive().default(10),
  dbStatementTimeoutMs: z.coerce.number().int().positive().default(30_000),

  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
});

export type Config = z.infer<typeof configSchema>;

/** Поля, которые нельзя выводить в логи ни при каких обстоятельствах. */
const SECRET_ENV_KEYS = [
  'LLM_API_KEY',
  'SUPADATA_API_KEY',
  'ADMIN_TOKEN',
  'YOUTUBE_API_KEY',
  'DATABASE_URL',
] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse({
    databaseUrl: env.DATABASE_URL,
    processingTimezone: env.PROCESSING_TIMEZONE,
    batchSize: env.BATCH_SIZE,
    workerConcurrency: env.WORKER_CONCURRENCY,
    claimLeaseMinutes: env.CLAIM_LEASE_MINUTES,
    maxAttempts: env.MAX_ATTEMPTS,
    heartbeatTimeoutMinutes: env.HEARTBEAT_TIMEOUT_MINUTES,
    schedulerEnabled: env.SCHEDULER_ENABLED,
    schedulerIntervalMinutes: env.SCHEDULER_INTERVAL_MINUTES,
    workerLeaseMinutes: env.WORKER_LEASE_MINUTES,
    workerHeartbeatIntervalSeconds: env.WORKER_HEARTBEAT_INTERVAL_SECONDS,
    maxPagesPerRun: env.MAX_PAGES_PER_RUN,
    maxEmptyPages: env.MAX_EMPTY_PAGES,
    reviewCriticPageSize: env.REVIEW_CRITIC_PAGE_SIZE,
    reviewUserPageSize: env.REVIEW_USER_PAGE_SIZE,
    reviewMaxPages: env.REVIEW_MAX_PAGES,
    reviewMaxCritic: env.REVIEW_MAX_CRITIC,
    reviewMaxUser: env.REVIEW_MAX_USER,
    llmEnabled: env.LLM_ENABLED,
    llmModel: env.LLM_MODEL,
    llmApiKey: env.LLM_API_KEY,
    llmMaxReviews: env.LLM_MAX_REVIEWS,
    llmMaxReviewChars: env.LLM_MAX_REVIEW_CHARS,
    llmMaxInputTokens: env.LLM_MAX_INPUT_TOKENS,
    llmMaxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
    llmTimeoutMs: env.LLM_TIMEOUT_MS,
    llmRetryCount: env.LLM_RETRY_COUNT,
    llmMinReviews: env.LLM_MIN_REVIEWS,
    llmPromptVersion: env.LLM_PROMPT_VERSION,
    llmSamplingVersion: env.LLM_SAMPLING_VERSION,
    metacriticRateLimitRps: env.METACRITIC_RATE_LIMIT_RPS,
    httpTimeoutMs: env.HTTP_TIMEOUT_MS,
    metacriticUserAgent: env.METACRITIC_USER_AGENT,
    metacriticFetchUserscore: env.METACRITIC_FETCH_USERSCORE,
    youtubeEnabled: env.YOUTUBE_ENABLED,
    youtubeApiKey: env.YOUTUBE_API_KEY,
    youtubeTimeoutMs: env.YOUTUBE_TIMEOUT_MS,
    youtubeMaxResults: env.YOUTUBE_MAX_RESULTS,
    youtubeMinDurationSeconds: env.YOUTUBE_MIN_DURATION_SECONDS,
    youtubeMaxDurationSeconds: env.YOUTUBE_MAX_DURATION_SECONDS,
    youtubeMaxTranscriptChars: env.YOUTUBE_MAX_TRANSCRIPT_CHARS,
    supadataApiKey: env.SUPADATA_API_KEY,
    supadataTimeoutMs: env.SUPADATA_TIMEOUT_MS,
    transcriptFallbackLanguage: env.TRANSCRIPT_FALLBACK_LANGUAGE,
    apiPort: env.API_PORT,
    apiHost: env.API_HOST,
    adminToken: env.ADMIN_TOKEN,
    apiRateLimitWindowMs: env.API_RATE_LIMIT_WINDOW_MS,
    apiRateLimitMax: env.API_RATE_LIMIT_MAX,
    apiDefaultPageSize: env.API_DEFAULT_PAGE_SIZE,
    apiMaxPageSize: env.API_MAX_PAGE_SIZE,
    dbPoolMax: env.DB_POOL_MAX,
    dbStatementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
    nodeEnv: env.NODE_ENV,
  });

  if (!parsed.success) {
    // Выводим только пути полей и сообщения — без значений,
    // чтобы секрет не утёк в лог через сообщение об ошибке.
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Некорректная конфигурация:\n${issues}`);
  }

  return parsed.data;
}

/**
 * Безопасное представление конфигурации для логов.
 * DATABASE_URL содержит пароль, поэтому маскируется целиком.
 */
export function redactConfig(config: Config): Record<string, unknown> {
  // Ключ модели и админ-токен маскируются наравне со строкой подключения.
  return {
    ...config,
    databaseUrl: '<redacted>',
    ...(config.llmApiKey !== undefined ? { llmApiKey: '<redacted>' } : {}),
    ...(config.adminToken !== undefined ? { adminToken: '<redacted>' } : {}),
    ...(config.youtubeApiKey !== undefined ? { youtubeApiKey: '<redacted>' } : {}),
    ...(config.supadataApiKey !== undefined ? { supadataApiKey: '<redacted>' } : {}),
  };
}

export { SECRET_ENV_KEYS };
