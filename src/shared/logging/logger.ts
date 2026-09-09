/**
 * Структурное логирование.
 *
 * Правила, обязательные к соблюдению:
 * - секреты (ключи, токены, cookies, Authorization) не логируются никогда;
 * - полный HTML-ответ не логируется — только его размер;
 * - вывод в формате JSON, пригодном для машинного разбора.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

/**
 * Поля, значения которых не должны попадать в лог ни при каких условиях.
 * Проверка идёт по подстроке в нижнем регистре, поэтому покрывает варианты
 * вроде `x-admin-token` и `apiKey`.
 */
const REDACTED_KEY_PATTERNS = [
  'authorization',
  'cookie',
  'set-cookie',
  'api_key',
  'apikey',
  'token',
  'password',
  'secret',
  'credential',
];

const REDACTED = '<redacted>';

/** Ограничение на длину строкового значения — защита от утечки целых страниц. */
const MAX_STRING_LENGTH = 512;

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return REDACTED_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

export function sanitizeFields(fields: LogFields, depth = 0): Record<string, unknown> {
  if (depth > 4) return {};

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (isSensitiveKey(key)) {
      result[key] = REDACTED;
      continue;
    }

    if (typeof value === 'string') {
      result[key] =
        value.length > MAX_STRING_LENGTH
          ? `${value.slice(0, MAX_STRING_LENGTH)}…(${value.length} симв.)`
          : value;
      continue;
    }

    if (value instanceof Error) {
      result[key] = { name: value.name, message: value.message };
      continue;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = sanitizeFields(value as LogFields, depth + 1);
      continue;
    }

    result[key] = value;
  }
  return result;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly bindings?: LogFields;
  readonly sink?: (line: string) => void;
  readonly now?: () => Date;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class StructuredLogger implements Logger {
  private readonly level: LogLevel;
  private readonly bindings: LogFields;
  private readonly sink: (line: string) => void;
  private readonly now: () => Date;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.bindings = options.bindings ?? {};
    this.sink = options.sink ?? ((line) => console.log(line));
    this.now = options.now ?? (() => new Date());
  }

  debug(message: string, fields?: LogFields): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write('error', message, fields);
  }

  child(bindings: LogFields): Logger {
    return new StructuredLogger({
      level: this.level,
      bindings: { ...this.bindings, ...bindings },
      sink: this.sink,
      now: this.now,
    });
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

    const payload = {
      ts: this.now().toISOString(),
      level,
      message,
      ...sanitizeFields({ ...this.bindings, ...(fields ?? {}) }),
    };

    this.sink(JSON.stringify(payload));
  }
}

/** Логгер, не выводящий ничего, — для тестов. */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};
