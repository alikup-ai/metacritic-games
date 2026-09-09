import type { VideoInsight as VideoInsightData } from '@/lib/api/types';
import { safeExternalUrl } from '@/lib/safe-url';

/**
 * Видеообзор от блогера.
 *
 * Недоступность ролика, субтитров или разбора показывается спокойным
 * сообщением: функция обогащающая, и её отсутствие не является поломкой.
 */

/** Объяснение, почему разбора нет. */
const REASONS: Record<string, string> = {
  no_relevant_video: 'Подходящего видеообзора не нашлось',
  transcript_unavailable: 'У видео нет субтитров, поэтому разбор недоступен',
  analysis_disabled: 'Разбор видео сейчас отключён',
  analysis_failed: 'Разбор видео не удался',
  quota_exceeded: 'Лимит обращений к YouTube исчерпан — попробуйте позже',
};

function formatViews(count: number | null): string | null {
  if (count === null) return null;
  return `${count.toLocaleString('ru-RU')} просмотров`;
}

export function VideoInsightSection({
  insight,
}: {
  readonly insight: VideoInsightData;
}): React.JSX.Element | null {
  // Обогащение не выполнялось — раздел не показывается вовсе
  if (insight.status === 'none') return null;

  const url = safeExternalUrl(insight.videoUrl);
  const views = formatViews(insight.viewCount);

  return (
    <section className="section" aria-labelledby="video-heading">
      <h3 id="video-heading">Видео от блогеров</h3>

      {insight.videoTitle ? (
        <div style={{ marginBottom: '1rem' }}>
          <p style={{ marginBottom: '0.25rem', fontWeight: 600 }}>
            {insight.videoTitle}
          </p>
          <p className="game-card__meta">
            {insight.channelTitle ?? 'неизвестный канал'}
            {views ? ` · ${views}` : ''}
          </p>

          {url ? (
            <p style={{ marginTop: '0.75rem' }}>
              <a
                className="button"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Смотреть на YouTube
              </a>
            </p>
          ) : null}
        </div>
      ) : null}

      {insight.status === 'ok' ? (
        <>
          {insight.summary ? <p>{insight.summary}</p> : null}

          {insight.liked.length > 0 ? (
            <>
              <h4>Что понравилось автору</h4>
              <ul className="point-list point-list--liked">
                {insight.liked.map((text, index) => (
                  <li key={`liked-${index}`} className="point-list__item">
                    <span className="point-list__marker" aria-hidden="true">
                      +
                    </span>
                    <span>{text}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {insight.disliked.length > 0 ? (
            <>
              <h4>Что не понравилось</h4>
              <ul className="point-list point-list--disliked">
                {insight.disliked.map((text, index) => (
                  <li key={`disliked-${index}`} className="point-list__item">
                    <span className="point-list__marker" aria-hidden="true">
                      −
                    </span>
                    <span>{text}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {insight.themes.length > 0 ? (
            <p className="game-card__meta">
              Темы: {insight.themes.join(', ')}
            </p>
          ) : null}

          {insight.conclusion ? (
            <div className="coverage" style={{ marginTop: '1rem' }}>
              <strong>Вывод: </strong>
              {insight.conclusion}
            </div>
          ) : null}

          {/* Мнение одного автора, а не аудитории — это важно не смешивать */}
          <p className="game-card__meta" style={{ marginTop: '1rem' }}>
            Это мнение одного автора видео, а не оценка всех игроков
          </p>
        </>
      ) : (
        <p className="notice">
          {REASONS[insight.reason ?? ''] ?? 'Разбор видео недоступен'}
        </p>
      )}
    </section>
  );
}
