import { describe, expect, it } from 'vitest';
import { Router } from '../../src/api/http/router.js';
import { ApiError, toApiError, toErrorBody } from '../../src/api/http/errors.js';
import { constantTimeEquals, requireAdminToken } from '../../src/api/http/auth.js';
import { RateLimiter } from '../../src/api/http/rate-limit.js';
import {
  parseEnum,
  parseLimit,
  parsePage,
  parsePageSize,
  parsePlatformSlug,
  parseSearch,
  parseUuid,
  REVIEW_KINDS,
  SORT_FIELDS,
  SORT_ORDERS,
} from '../../src/api/http/validation.js';
import { toPagination } from '../../src/api/dto/index.js';

/** Тесты транспортного слоя без сети и без БД. */

const noop = async () => ({ status: 200, body: {} });

// ============================================================================
// Маршрутизация
// ============================================================================

describe('Маршрутизация', () => {
  const router = new Router()
    .get('/api/games', noop)
    .get('/api/games/:id', noop)
    .get('/api/games/:id/reviews', noop)
    .post('/api/runs', noop);

  it('находит статический путь', () => {
    expect(router.match('GET', '/api/games')).not.toBeNull();
  });

  it('извлекает параметр пути', () => {
    const matched = router.match('GET', '/api/games/abc-123');
    expect(matched).not.toBe('method_not_allowed');
    expect((matched as { params: Record<string, string> }).params.id).toBe('abc-123');
  });

  it('различает вложенные маршруты', () => {
    const matched = router.match('GET', '/api/games/xyz/reviews');
    expect((matched as { params: Record<string, string> }).params.id).toBe('xyz');
  });

  it('неизвестный путь не находится', () => {
    expect(router.match('GET', '/api/unknown')).toBeNull();
  });

  it('различает отсутствие пути и неверный метод', () => {
    // Существующий путь с другим методом — это 405, а не 404
    expect(router.match('POST', '/api/games')).toBe('method_not_allowed');
    expect(router.match('GET', '/api/nothing')).toBeNull();
  });

  it('лишний сегмент не совпадает', () => {
    expect(router.match('GET', '/api/games/a/b/c')).toBeNull();
  });

  it('раскодирует параметр пути', () => {
    const matched = router.match('GET', '/api/games/a%20b');
    expect((matched as { params: Record<string, string> }).params.id).toBe('a b');
  });

  it('метод сопоставляется без учёта регистра', () => {
    expect(router.match('get', '/api/games')).not.toBeNull();
  });
});

// ============================================================================
// Проверка параметров
// ============================================================================

describe('Проверка номера страницы', () => {
  it('по умолчанию первая страница', () => {
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage('')).toBe(1);
  });

  it('принимает положительное целое', () => {
    expect(parsePage('5')).toBe(5);
  });

  it('отклоняет ноль, отрицательные и дробные', () => {
    for (const value of ['0', '-1', '1.5', 'abc', 'NaN', 'Infinity']) {
      expect(() => parsePage(value)).toThrow(ApiError);
    }
  });
});

describe('Проверка размера страницы', () => {
  const defaults = { defaultSize: 20, maxSize: 100 };

  it('по умолчанию заданный размер', () => {
    expect(parsePageSize(undefined, defaults)).toBe(20);
  });

  it('принимает значение в пределах', () => {
    expect(parsePageSize('50', defaults)).toBe(50);
    expect(parsePageSize('100', defaults)).toBe(100);
  });

  it('отклоняет превышение предела', () => {
    // Без предела один запрос мог бы нагрузить базу
    expect(() => parsePageSize('101', defaults)).toThrow(ApiError);
    expect(() => parsePageSize('100000', defaults)).toThrow(ApiError);
  });

  it('отклоняет некорректные значения', () => {
    for (const value of ['0', '-5', 'abc', '10.5']) {
      expect(() => parsePageSize(value, defaults)).toThrow(ApiError);
    }
  });
});

describe('Проверка перечислений', () => {
  it('принимает значение из белого списка', () => {
    expect(parseEnum('title', SORT_FIELDS, 'sort')).toBe('title');
    expect(parseEnum('asc', SORT_ORDERS, 'order')).toBe('asc');
    expect(parseEnum('user', REVIEW_KINDS, 'kind')).toBe('user');
  });

  it('подставляет значение по умолчанию при отсутствии', () => {
    expect(parseEnum(undefined, SORT_FIELDS, 'sort', 'metascore')).toBe('metascore');
  });

  it('отклоняет значение вне списка', () => {
    expect(() => parseEnum('id', SORT_FIELDS, 'sort')).toThrow(ApiError);
    expect(() => parseEnum('DESC; DROP', SORT_ORDERS, 'order')).toThrow(ApiError);
  });

  it('сообщение об ошибке не содержит присланное значение', () => {
    const marker = 'ОПАСНОЕ_ЗНАЧЕНИЕ';
    try {
      parseEnum(marker, SORT_FIELDS, 'sort');
      expect.unreachable('должно было выбросить');
    } catch (error) {
      expect((error as Error).message).not.toContain(marker);
      // Зато сообщаются допустимые варианты
      expect((error as ApiError).details?.allowed).toEqual(SORT_FIELDS);
    }
  });

  it('свойства прототипа не проходят как значения', () => {
    for (const value of ['__proto__', 'constructor', 'toString']) {
      expect(() => parseEnum(value, SORT_FIELDS, 'sort')).toThrow(ApiError);
    }
  });
});

describe('Проверка UUID', () => {
  it('принимает корректный UUID', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    expect(parseUuid(id, 'id')).toBe(id);
  });

  it('отклоняет некорректные значения', () => {
    for (const value of [
      undefined,
      '',
      'not-a-uuid',
      '550e8400-e29b-41d4-a716',
      '../../etc/passwd',
      "1' OR '1'='1",
      '00000000-0000-0000-0000-000000000000',
    ]) {
      expect(() => parseUuid(value, 'id')).toThrow(ApiError);
    }
  });
});

describe('Проверка строки поиска', () => {
  it('пустая строка считается отсутствующей', () => {
    expect(parseSearch(undefined)).toBeUndefined();
    expect(parseSearch('   ')).toBeUndefined();
  });

  it('обрезает пробелы по краям', () => {
    expect(parseSearch('  witcher  ')).toBe('witcher');
  });

  it('отклоняет чрезмерно длинную строку', () => {
    expect(() => parseSearch('x'.repeat(101))).toThrow(ApiError);
  });

  it('спецсимволы допускаются: запрос параметризован', () => {
    // Отклонять их не нужно — они не влияют на структуру запроса
    expect(parseSearch("100% Orange Juice")).toBe('100% Orange Juice');
    expect(parseSearch("Assassin's Creed")).toBe("Assassin's Creed");
  });
});

describe('Проверка платформы', () => {
  it('приводит к нижнему регистру', () => {
    expect(parsePlatformSlug('PlayStation-5')).toBe('playstation-5');
  });

  it('отклоняет посторонние символы', () => {
    for (const value of ["pc'; DROP TABLE", 'pc OR 1=1', 'pc/../etc', 'pc;drop']) {
      expect(() => parsePlatformSlug(value)).toThrow(ApiError);
    }
  });

  it('пустая строка считается отсутствующей', () => {
    expect(parsePlatformSlug('')).toBeUndefined();
  });
});

describe('Проверка limit', () => {
  const defaults = { defaultLimit: 20, maxLimit: 100 };

  it('подрезает превышение вместо отказа', () => {
    expect(parseLimit('99999', defaults)).toBe(100);
  });

  it('отклоняет нечисловое значение', () => {
    expect(() => parseLimit('abc', defaults)).toThrow(ApiError);
  });
});

// ============================================================================
// Пагинация
// ============================================================================

describe('Расчёт пагинации', () => {
  it('считает количество страниц', () => {
    expect(toPagination({ page: 1, pageSize: 20, total: 45 }).totalPages).toBe(3);
    expect(toPagination({ page: 1, pageSize: 20, total: 40 }).totalPages).toBe(2);
  });

  it('пустой результат даёт одну страницу', () => {
    // Ноль страниц сделал бы page=1 недопустимым
    expect(toPagination({ page: 1, pageSize: 20, total: 0 }).totalPages).toBe(1);
  });
});

// ============================================================================
// Ошибки
// ============================================================================

describe('Формат ошибок', () => {
  it('код соответствует статусу', () => {
    expect(new ApiError('VALIDATION_ERROR', 'x').status).toBe(400);
    expect(new ApiError('UNAUTHORIZED', 'x').status).toBe(401);
    expect(new ApiError('FORBIDDEN', 'x').status).toBe(403);
    expect(new ApiError('GAME_NOT_FOUND', 'x').status).toBe(404);
    expect(new ApiError('CONFLICT', 'x').status).toBe(409);
    expect(new ApiError('RATE_LIMITED', 'x').status).toBe(429);
    expect(new ApiError('INTERNAL_ERROR', 'x').status).toBe(500);
    expect(new ApiError('SERVICE_UNAVAILABLE', 'x').status).toBe(503);
  });

  it('произвольная ошибка становится внутренней', () => {
    const converted = toApiError(new Error('детали устройства системы'));

    expect(converted.code).toBe('INTERNAL_ERROR');
    // Исходное сообщение наружу не идёт
    expect(converted.message).not.toContain('детали устройства системы');
  });

  it('типизированная ошибка проходит без изменений', () => {
    const original = new ApiError('GAME_NOT_FOUND', 'Игра не найдена');
    expect(toApiError(original)).toBe(original);
  });

  it('тело ответа содержит код, сообщение и requestId', () => {
    const body = toErrorBody(new ApiError('GAME_NOT_FOUND', 'Игра не найдена'), 'req-1');

    expect(body.error.code).toBe('GAME_NOT_FOUND');
    expect(body.error.message).toBe('Игра не найдена');
    expect(body.error.requestId).toBe('req-1');
  });

  it('в теле нет трассировки стека', () => {
    const body = toErrorBody(toApiError(new Error('сбой')), 'req-1');
    expect(JSON.stringify(body)).not.toContain('stack');
  });
});

// ============================================================================
// Авторизация
// ============================================================================

describe('Сравнение токена', () => {
  it('одинаковые строки совпадают', () => {
    expect(constantTimeEquals('secret-token', 'secret-token')).toBe(true);
  });

  it('разные строки не совпадают', () => {
    expect(constantTimeEquals('secret-token', 'secret-tokeN')).toBe(false);
  });

  it('строки разной длины сравниваются без исключения', () => {
    // Сравниваются хеши: иначе длина ожидаемого токена утекла бы
    expect(constantTimeEquals('a', 'a'.repeat(100))).toBe(false);
    expect(constantTimeEquals('', 'nonempty')).toBe(false);
  });
});

describe('Требование админ-токена', () => {
  const expectedToken = 'valid-token-1234567890';

  it('корректный токен проходит', () => {
    expect(() =>
      requireAdminToken({ headerValue: expectedToken, expectedToken }),
    ).not.toThrow();
  });

  it('отсутствие заголовка даёт 401', () => {
    try {
      requireAdminToken({ headerValue: undefined, expectedToken });
      expect.unreachable('должно было выбросить');
    } catch (error) {
      expect((error as ApiError).status).toBe(401);
    }
  });

  it('неверный токен даёт 403', () => {
    try {
      requireAdminToken({ headerValue: 'wrong', expectedToken });
      expect.unreachable('должно было выбросить');
    } catch (error) {
      expect((error as ApiError).status).toBe(403);
    }
  });

  it('ненастроенный токен делает операцию недоступной', () => {
    try {
      requireAdminToken({ headerValue: 'anything', expectedToken: undefined });
      expect.unreachable('должно было выбросить');
    } catch (error) {
      // Открытый endpoint был бы опаснее отключённого
      expect((error as ApiError).status).toBe(503);
    }
  });

  it('сообщения об ошибке не содержат токена', () => {
    for (const headerValue of [undefined, 'wrong-token']) {
      try {
        requireAdminToken({ headerValue, expectedToken });
      } catch (error) {
        const message = (error as Error).message;
        expect(message).not.toContain(expectedToken);
        if (headerValue) expect(message).not.toContain(headerValue);
      }
    }
  });
});

// ============================================================================
// Ограничение частоты
// ============================================================================

describe('Ограничение частоты', () => {
  it('пропускает в пределах лимита', () => {
    const limiter = new RateLimiter({ windowMs: 1000, max: 3 });

    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(true);
  });

  it('отклоняет при превышении', () => {
    const limiter = new RateLimiter({ windowMs: 1000, max: 2 });

    limiter.check('a');
    limiter.check('a');
    const decision = limiter.check('a');

    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('ключи независимы', () => {
    const limiter = new RateLimiter({ windowMs: 1000, max: 1 });

    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('b').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
  });

  it('окно сбрасывается по истечении', () => {
    let now = 1000;
    const limiter = new RateLimiter({ windowMs: 1000, max: 1, now: () => now });

    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);

    now += 1001;
    expect(limiter.check('a').allowed).toBe(true);
  });

  it('очистка удаляет истёкшие корзины', () => {
    let now = 1000;
    const limiter = new RateLimiter({ windowMs: 100, max: 1, now: () => now });

    limiter.check('a');
    now += 200;
    limiter.prune();

    // После очистки счётчик начинается заново
    expect(limiter.check('a').allowed).toBe(true);
  });
});
