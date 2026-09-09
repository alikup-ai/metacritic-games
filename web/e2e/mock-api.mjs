import { createServer } from 'node:http';

/**
 * Поддельный бэкенд для E2E.
 *
 * Отвечает по контракту docs/API.md. Ни к Metacritic, ни к OpenRouter, ни
 * к PostgreSQL обращений нет: проверяется поведение интерфейса, а не
 * работоспособность бэкенда — она покрыта тестами Phase 3A.
 *
 * Особый режим: заголовок X-Mock-Failure заставляет отвечать ошибкой.
 */

const PORT = Number(process.env.MOCK_API_PORT ?? 3101);

/** Игры с намеренно разными сочетаниями данных. */
const GAMES = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'The Witcher 3: Wild Hunt',
    coverUrl: 'https://example.test/witcher.jpg',
    releaseDate: '2015-05-19',
    developer: 'CD Projekt Red',
    metascore: 93,
    userscore: 9.2,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    title: 'Cyberpunk 2077',
    coverUrl: null,
    releaseDate: '2020-12-10',
    // Разработчик неизвестен: проверяем, что издатель не подставляется
    developer: null,
    metascore: 71,
    userscore: 4.8,
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    title: 'Hollow Knight',
    coverUrl: 'https://example.test/hollow.jpg',
    releaseDate: '2017-02-24',
    developer: 'Team Cherry',
    // Оценок нет вовсе
    metascore: null,
    userscore: null,
  },
];

const PLATFORMS = [
  { slug: 'pc', name: 'PC' },
  { slug: 'playstation-5', name: 'PlayStation 5' },
];

/** Платформы игр; xbox-one намеренно отсутствует — она отключена. */
const GAME_PLATFORMS = {
  '11111111-1111-4111-8111-111111111111': [
    {
      slug: 'pc',
      name: 'PC',
      metascore: 93,
      metascoreScope: 'platform',
      userscore: 9.2,
      // Общий Userscore: не выдаётся за оценку платформы
      userscoreScope: 'overall',
      criticCount: 33,
      userCount: null,
    },
    {
      slug: 'playstation-5',
      name: 'PlayStation 5',
      metascore: 91,
      metascoreScope: 'platform',
      userscore: 9.2,
      userscoreScope: 'overall',
      criticCount: 12,
      userCount: null,
    },
  ],
  '22222222-2222-4222-8222-222222222222': [
    {
      slug: 'pc',
      name: 'PC',
      metascore: 86,
      // Связать оценку с платформой не удалось — признак деградации
      metascoreScope: 'overall_fallback',
      userscore: 4.8,
      userscoreScope: 'overall',
      criticCount: 60,
      userCount: null,
    },
  ],
  '33333333-3333-4333-8333-333333333333': [],
};

const ANALYSIS = {
  // Полный анализ: обе аудитории
  '11111111-1111-4111-8111-111111111111': {
    critic: {
      status: 'ok',
      platformSlug: 'pc',
      summary: 'Критики отмечают проработанный открытый мир и побочные задания.',
      liked: [{ text: 'Побочные задания', evidenceRefs: ['r1', 'r3'] }],
      disliked: [{ text: 'Технические огрехи', evidenceRefs: ['r7'] }],
      themes: [
        {
          name: 'повествование',
          sentiment: 'positive',
          description: 'Хвалят сценарий и персонажей',
          evidenceRefs: ['r1'],
        },
      ],
      confidence: 'high',
      analyzedCount: 33,
      totalAvailable: 33,
      coverage: 'all_reviews',
      snapshotCompleteness: 'complete',
      model: 'anthropic/claude-haiku-4.5',
      promptVersion: 'v1',
      analyzedAt: '2026-09-08T09:00:00.000Z',
    },
    user: {
      status: 'ok',
      platformSlug: 'pc',
      summary: 'Игроки хвалят объём контента, но жалуются на производительность.',
      liked: [{ text: 'Объём контента', evidenceRefs: ['r2'] }],
      disliked: [{ text: 'Просадки кадров', evidenceRefs: ['r5'] }],
      themes: [],
      confidence: 'medium',
      // Выборка из большого объёма — раскрытие обязательно
      analyzedCount: 200,
      totalAvailable: 6595,
      coverage: 'sample',
      snapshotCompleteness: 'partial',
      model: 'anthropic/claude-haiku-4.5',
      promptVersion: 'v1',
      analyzedAt: '2026-09-08T09:05:00.000Z',
    },
  },
  // Только анализ игроков: критиков нет
  '22222222-2222-4222-8222-222222222222': {
    critic: null,
    user: {
      status: 'ok',
      platformSlug: 'pc',
      summary: 'Игроки отмечают улучшения после патчей.',
      liked: [],
      disliked: [{ text: 'Состояние на старте', evidenceRefs: ['r1'] }],
      themes: [],
      confidence: 'low',
      analyzedCount: 50,
      totalAvailable: 1200,
      coverage: 'sample',
      // Сбор прерван — состояние должно быть видно
      snapshotCompleteness: 'incomplete',
      model: 'anthropic/claude-haiku-4.5',
      promptVersion: 'v1',
      analyzedAt: '2026-09-08T09:10:00.000Z',
    },
  },
  // Анализа нет вовсе
  '33333333-3333-4333-8333-333333333333': { critic: null, user: null },
};

const DETAILS = {
  '11111111-1111-4111-8111-111111111111': {
    description: 'Ролевая игра о ведьмаке Геральте.',
    videoUrl: 'https://example.test/witcher-trailer',
    genres: ['RPG', 'Action'],
    publishers: ['CD Projekt'],
    developerStatus: 'resolved',
  },
  '22222222-2222-4222-8222-222222222222': {
    description: 'Приключение в Найт-Сити.',
    // Опасная схема: интерфейс обязан её отбросить
    videoUrl: 'javascript:alert(document.domain)',
    genres: ['RPG'],
    publishers: ['CD Projekt'],
    developerStatus: 'unknown',
  },
  '33333333-3333-4333-8333-333333333333': {
    // Текст с разметкой: проверяем экранирование
    description: '<img src=x onerror="alert(1)"> Метроидвания <script>alert(2)</script>',
    videoUrl: null,
    genres: [],
    publishers: [],
    developerStatus: 'resolved',
  },
};

/** Состояние мониторинга: обработчик работает, есть история запусков. */
const RUNS = [
  {
    id: 'aaaaaaaa-1111-4111-8111-111111111111',
    trigger: 'cron',
    status: 'running',
    processingDay: '2026-09-09',
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    finishedAt: null,
    processed: 7,
    failed: 1,
  },
  {
    id: 'bbbbbbbb-2222-4222-8222-222222222222',
    trigger: 'manual',
    status: 'completed',
    processingDay: '2026-09-08',
    startedAt: '2026-09-08T10:00:00.000Z',
    finishedAt: '2026-09-08T10:04:12.000Z',
    processed: 18,
    failed: 2,
  },
];

const RUN_DETAILS = {
  'bbbbbbbb-2222-4222-8222-222222222222': {
    source: 'browse',
    planned: 20,
    claimed: 20,
    succeeded: 16,
    partial: 2,
    skipped: 0,
    pagesScanned: 3,
    errorSummary: null,
    stages: [
      { stage: 'fetchGame', done: 20, failed: 0, skipped: 0, pending: 0 },
      { stage: 'fetchReviews', done: 18, failed: 2, skipped: 0, pending: 0 },
      { stage: 'summarize', done: 16, failed: 0, skipped: 4, pending: 0 },
    ],
  },
};

/** Обогащение видео: успешное, деградировавшее и отсутствующее. */
const VIDEO_INSIGHTS = {
  '11111111-1111-4111-8111-111111111111': {
    status: 'ok',
    reason: null,
    videoId: 'abc123',
    videoUrl: 'https://www.youtube.com/watch?v=abc123',
    videoTitle: 'The Witcher 3 — полный обзор',
    channelTitle: 'GameChannel',
    viewCount: 1234567,
    publishedAt: '2026-01-01T00:00:00Z',
    durationSeconds: 1800,
    transcriptSource: 'official',
    summary: 'Автор хвалит проработанный мир и побочные задания.',
    liked: ['Побочные задания', 'Атмосфера мира'],
    disliked: ['Технические огрехи на старте'],
    themes: ['повествование', 'мир'],
    conclusion: 'Игра остаётся эталоном жанра.',
    model: 'anthropic/claude-haiku-4.5',
    analyzedAt: '2026-09-09T10:00:00.000Z',
  },
  // Ролик найден, но субтитров нет — деградация
  '22222222-2222-4222-8222-222222222222': {
    status: 'skipped',
    reason: 'transcript_unavailable',
    videoId: 'def456',
    videoUrl: 'https://www.youtube.com/watch?v=def456',
    videoTitle: 'Cyberpunk 2077 Gameplay',
    channelTitle: 'AnotherChannel',
    viewCount: 98765,
    publishedAt: '2026-02-01T00:00:00Z',
    durationSeconds: 900,
    transcriptSource: 'metadata_only',
    summary: null,
    liked: [],
    disliked: [],
    themes: [],
    conclusion: null,
    model: null,
    analyzedAt: '2026-09-09T10:05:00.000Z',
  },
};

const EMPTY_VIDEO = {
  status: 'none', reason: null, videoId: null, videoUrl: null,
  videoTitle: null, channelTitle: null, viewCount: null, publishedAt: null,
  durationSeconds: null, transcriptSource: 'none', summary: null,
  liked: [], disliked: [], themes: [], conclusion: null,
  model: null, analyzedAt: null,
};

function json(response, status, body, requestId = 'mock-request-id') {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-request-id': requestId,
  });
  response.end(JSON.stringify(body));
}

function errorBody(code, message) {
  return { error: { code, message, requestId: 'mock-request-id' } };
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname;

  // Управляемый сбой: проверка поведения интерфейса при отказе API
  if (request.headers['x-mock-failure'] === 'true' || process.env.MOCK_FAIL === 'true') {
    json(response, 503, errorBody('SERVICE_UNAVAILABLE', 'Сервис временно недоступен'));
    return;
  }

  if (path === '/api/health') {
    json(response, 200, { status: 'ok', timestamp: new Date().toISOString() });
    return;
  }

  if (path === '/api/monitoring/workers') {
    json(response, 200, {
      items: [
        {
          name: 'daily-processing',
          status: 'running',
          lastHeartbeat: new Date(Date.now() - 15_000).toISOString(),
          currentRunId: RUNS[0].id,
          processed: 7,
          failed: 1,
        },
      ],
    });
    return;
  }

  if (path === '/api/runs' && request.method === 'GET') {
    json(response, 200, { items: RUNS });
    return;
  }

  if (path === '/api/runs' && request.method === 'POST') {
    // Обработка уже идёт — конфликт состояния, а не ошибка
    json(response, 409, {
      runId: null,
      outcome: 'skipped',
      processingDay: '2026-09-09',
      claimed: 0,
      processed: 0,
      failed: 0,
      skipped: 0,
      stopReason: 'already_running',
    });
    return;
  }

  const runMatch = /^\/api\/runs\/([^/]+)$/.exec(path);
  if (runMatch) {
    const id = decodeURIComponent(runMatch[1]);
    const base = RUNS.find((r) => r.id === id);
    if (!base) {
      json(response, 404, errorBody('RUN_NOT_FOUND', 'Запуск не найден'));
      return;
    }
    json(response, 200, { ...base, ...(RUN_DETAILS[id] ?? {
      source: null, planned: 20, claimed: 20, succeeded: 0, partial: 0,
      skipped: 0, pagesScanned: 0, errorSummary: null, stages: [],
    }) });
    return;
  }

  if (path === '/api/platforms') {
    // Только активные платформы: xbox-one отключена и не возвращается
    json(response, 200, { items: PLATFORMS });
    return;
  }

  if (path === '/api/games') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const platform = url.searchParams.get('platform') ?? '';
    const sort = url.searchParams.get('sort') ?? 'metascore';
    const order = url.searchParams.get('order') ?? 'desc';
    const page = Number(url.searchParams.get('page') ?? '1');
    const pageSize = Number(url.searchParams.get('pageSize') ?? '20');

    if (!['metascore', 'userscore', 'releaseDate', 'title'].includes(sort)) {
      json(response, 400, errorBody('VALIDATION_ERROR', 'Недопустимое значение параметра sort'));
      return;
    }

    let items = GAMES.filter((game) => game.title.toLowerCase().includes(q));

    if (platform) {
      items = items.filter((game) =>
        (GAME_PLATFORMS[game.id] ?? []).some((p) => p.slug === platform),
      );
    }

    const direction = order === 'asc' ? 1 : -1;
    items = [...items].sort((a, b) => {
      if (sort === 'title') return a.title.localeCompare(b.title) * direction;
      if (sort === 'releaseDate') {
        return String(a.releaseDate).localeCompare(String(b.releaseDate)) * direction;
      }
      const key = sort === 'userscore' ? 'userscore' : 'metascore';
      // null всегда в конце при убывании — как на бэкенде
      if (a[key] === null) return 1;
      if (b[key] === null) return -1;
      return (a[key] - b[key]) * direction;
    });

    const total = items.length;
    const start = (page - 1) * pageSize;

    json(response, 200, {
      items: items.slice(start, start + pageSize),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    });
    return;
  }

  const videoMatch = /^\/api\/games\/([^/]+)\/video$/.exec(path);
  if (videoMatch) {
    const id = decodeURIComponent(videoMatch[1]);
    if (!GAMES.some((g) => g.id === id)) {
      json(response, 404, errorBody('GAME_NOT_FOUND', 'Игра не найдена'));
      return;
    }
    json(response, 200, VIDEO_INSIGHTS[id] ?? EMPTY_VIDEO);
    return;
  }

  const analysisMatch = /^\/api\/games\/([^/]+)\/analysis$/.exec(path);
  if (analysisMatch) {
    const id = decodeURIComponent(analysisMatch[1]);
    const found = ANALYSIS[id];
    if (!found) {
      json(response, 404, errorBody('GAME_NOT_FOUND', 'Игра не найдена'));
      return;
    }
    json(response, 200, { gameId: id, ...found });
    return;
  }

  const detailMatch = /^\/api\/games\/([^/]+)$/.exec(path);
  if (detailMatch) {
    const id = decodeURIComponent(detailMatch[1]);
    const game = GAMES.find((g) => g.id === id);

    if (!game) {
      json(response, 404, errorBody('GAME_NOT_FOUND', 'Игра не найдена'));
      return;
    }

    const extra = DETAILS[id];
    json(response, 200, {
      id: game.id,
      title: game.title,
      coverUrl: game.coverUrl,
      description: extra.description,
      videoUrl: extra.videoUrl,
      releaseDate: game.releaseDate,
      genres: extra.genres,
      developer: game.developer,
      developerStatus: extra.developerStatus,
      publishers: extra.publishers,
      metascore: game.metascore,
      userscore: game.userscore,
      platforms: GAME_PLATFORMS[id] ?? [],
      similar: [],
      sourceUrl: 'https://example.test/source',
      lastUpdatedAt: '2026-09-08T10:00:00.000Z',
    });
    return;
  }

  json(response, 404, errorBody('NOT_FOUND', 'Ресурс не найден'));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock api listening on ${PORT}`);
});
