import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AnalysisCard } from '@/components/AnalysisCard';
import { Score } from '@/components/Score';
import { SimilarGames } from '@/components/SimilarGames';
import { VideoInsightSection } from '@/components/VideoInsight';
import { ApiRequestError, fetchAnalysis, fetchGame, fetchVideoInsight } from '@/lib/api/client';
import { scopeNote } from '@/lib/coverage';
import { safeExternalUrl, safeImageUrl } from '@/lib/safe-url';
import type { GameAnalysis, VideoInsight as VideoInsightData } from '@/lib/api/types';

/**
 * Карточка игры.
 *
 * Серверный компонент. Оценки приходят готовыми и здесь не вычисляются;
 * различия developer/publisher и области действия оценок сохраняются.
 *
 * У сегмента НЕТ loading.tsx намеренно. Он создал бы границу Suspense,
 * ответ начал бы передаваться с кодом 200, и notFound() уже не смог бы
 * его изменить — отсутствующая игра отдавалась бы как 200 с текстом
 * «не найдено». Проверка существования обязана выполняться до начала
 * передачи ответа.
 */

interface PageProps {
  readonly params: Promise<{ id: string }>;
}

function formatDate(value: string | null): string | null {
  if (!value) return null;

  // YYYY-MM-DD — календарная дата; разбираем по частям, чтобы часовой
  // пояс не сдвинул день на сутки назад.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;

  const [, year, month, day] = match;
  return `${day}.${month}.${year}`;
}

export default async function GamePage({ params }: PageProps): Promise<React.JSX.Element> {
  const { id } = await params;

  let game;
  let missing = false;
  let loadError: ApiRequestError | Error | null = null;

  try {
    game = await fetchGame(id);
  } catch (error) {
    // Отсутствующая игра и некорректный идентификатор ведут на одну
    // страницу «не найдено»: для пользователя разницы нет.
    if (error instanceof ApiRequestError && (error.isNotFound || error.status === 400)) {
      missing = true;
    } else {
      loadError = error instanceof Error ? error : new Error('unknown');
    }
  }

  // notFound() вызывается ВНЕ catch: он работает через исключение, и
  // внутри обработчика оно было бы перехвачено — страница отрисовалась
  // бы, но с кодом 200 вместо 404.
  if (missing) notFound();

  if (loadError || !game) {
    const error = loadError;
    return (
      <div className="empty-state">
        <h2 className="empty-state__title">Данные недоступны</h2>
        <p>
          {error instanceof ApiRequestError
            ? error.message
            : 'Не удалось загрузить страницу игры'}
        </p>
        <p>
          <Link href="/">Вернуться в каталог</Link>
        </p>
      </div>
    );
  }

  // Сбой анализа не должен ломать страницу игры: это отдельный,
  // обогащающий раздел.
  let analysis: GameAnalysis | null = null;
  let analysisFailed = false;
  try {
    analysis = await fetchAnalysis(id);
  } catch {
    analysisFailed = true;
  }

  // Видеообзор — необязательное обогащение: его отсутствие или сбой
  // не влияют на остальную страницу.
  let videoInsight: VideoInsightData | null = null;
  try {
    videoInsight = await fetchVideoInsight(id);
  } catch {
    videoInsight = null;
  }

  const cover = safeImageUrl(game.coverUrl);
  const video = safeExternalUrl(game.videoUrl);
  const source = safeExternalUrl(game.sourceUrl);
  const released = formatDate(game.releaseDate);

  return (
    <article>
      <p style={{ marginBottom: '1rem' }}>
        <Link href="/">← Вернуться в каталог</Link>
      </p>

      <div className="game-header">
        <div>
          {cover ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={cover}
              alt={`Обложка игры «${game.title}»`}
              className="game-header__cover"
            />
          ) : (
            <div
              className="game-card__cover game-card__cover--empty game-header__cover"
              aria-hidden="true"
            >
              Нет обложки
            </div>
          )}
        </div>

        <div>
          <h2>{game.title}</h2>

          <div className="game-card__scores" style={{ marginBottom: '1rem' }}>
            <Score value={game.metascore} kind="metascore" label="Критики" />
            <Score value={game.userscore} kind="userscore" label="Игроки" />
          </div>

          <dl className="definition-list">
            <dt>Разработчик</dt>
            <dd>
              {/* Издатель сюда не подставляется ни при каких условиях */}
              {game.developer ?? 'неизвестен'}
            </dd>

            <dt>Издатель</dt>
            <dd>
              {game.publishers.length > 0 ? game.publishers.join(', ') : 'неизвестен'}
            </dd>

            {released ? (
              <>
                <dt>Дата выхода</dt>
                <dd>{released}</dd>
              </>
            ) : null}

            {game.genres.length > 0 ? (
              <>
                <dt>Жанры</dt>
                <dd>{game.genres.join(', ')}</dd>
              </>
            ) : null}
          </dl>

          {video ? (
            <p>
              {/* Внешняя ссылка: схема проверена, noopener обязателен */}
              <a
                className="button"
                href={video}
                target="_blank"
                rel="noopener noreferrer"
              >
                Смотреть видео
              </a>
            </p>
          ) : null}
        </div>
      </div>

      {game.description ? (
        <section className="section">
          <h3>Описание</h3>
          {/* Текст выводится как содержимое: React экранирует его сам */}
          <p>{game.description}</p>
        </section>
      ) : null}

      <section className="section">
        <h3>Платформы и оценки</h3>

        {game.platforms.length === 0 ? (
          <p className="notice">Сведения о платформах отсутствуют</p>
        ) : (
          <div className="table-scroll">
            <table className="platform-table">
              <thead>
                <tr>
                  <th scope="col">Платформа</th>
                  <th scope="col">Критики</th>
                  <th scope="col">Игроки</th>
                  <th scope="col">Рецензий</th>
                </tr>
              </thead>
              <tbody>
                {game.platforms.map((platform) => {
                  const metaNote = scopeNote(platform.metascoreScope);
                  const userNote = scopeNote(platform.userscoreScope);

                  return (
                    <tr key={platform.slug}>
                      <th scope="row">{platform.name}</th>
                      <td>
                        {platform.metascore ?? '—'}
                        {metaNote ? (
                          <div className="game-card__meta">{metaNote}</div>
                        ) : null}
                      </td>
                      <td>
                        {platform.userscore ?? '—'}
                        {userNote ? (
                          <div className="game-card__meta">{userNote}</div>
                        ) : null}
                      </td>
                      <td>{platform.criticCount ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <h3>Разбор отзывов</h3>

      {analysisFailed ? (
        <p className="notice">Разбор отзывов сейчас недоступен</p>
      ) : (
        <div className="analysis-grid">
          <AnalysisCard
            title="Мнение критиков"
            description="По рецензиям профессиональных изданий"
            analysis={analysis?.critic ?? null}
          />
          <AnalysisCard
            title="Мнение игроков"
            description="По отзывам пользователей"
            analysis={analysis?.user ?? null}
          />
        </div>
      )}

      {/* Раздел не отрисовывается, если обогащение не выполнялось */}
      {videoInsight ? <VideoInsightSection insight={videoInsight} /> : null}

      {/* Раздел не отрисовывается, если похожих игр нет */}
      <SimilarGames games={game.similar} />

      {source ? (
        <p className="game-card__meta">
          <a href={source} target="_blank" rel="noopener noreferrer">
            Источник данных
          </a>
        </p>
      ) : null}
    </article>
  );
}
