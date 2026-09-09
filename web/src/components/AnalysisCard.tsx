import type { Analysis } from '@/lib/api/types';
import {
  confidenceLabel,
  coverageMessage,
  isPartialView,
  snapshotMessage,
  statusMessage,
} from '@/lib/coverage';

/**
 * Резюме отзывов одной аудитории.
 *
 * Критики и игроки показываются раздельно и никогда не сводятся в один
 * текст: это разные аудитории и разные шкалы оценок.
 *
 * Если анализа нет, компонент честно сообщает об этом. Придумывать
 * формулировки вроде «отзывы в основном положительные» недопустимо:
 * отсутствие данных — это отсутствие данных.
 */

interface AnalysisCardProps {
  readonly title: string;
  readonly analysis: Analysis | null;
  /** Пояснение, что это за аудитория. */
  readonly description: string;
}

function PointList({
  items,
  variant,
  heading,
}: {
  readonly items: Analysis['liked'];
  readonly variant: 'liked' | 'disliked';
  readonly heading: string;
}): React.JSX.Element | null {
  if (items.length === 0) return null;

  return (
    <>
      <h4>{heading}</h4>
      <ul className={`point-list point-list--${variant}`}>
        {items.map((point, index) => (
          <li
            key={`${variant}-${index}`}
            className="point-list__item"
            // Ссылки на отзывы — часть происхождения вывода. Пользователю
            // они не показываются как текст, но сохраняются в разметке.
            data-evidence-refs={point.evidenceRefs.join(' ')}
          >
            <span className="point-list__marker" aria-hidden="true">
              {variant === 'liked' ? '+' : '−'}
            </span>
            <span>{point.text}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

export function AnalysisCard({
  title,
  analysis,
  description,
}: AnalysisCardProps): React.JSX.Element {
  if (!analysis) {
    return (
      <section className="section" aria-labelledby={`analysis-${title}`}>
        <h3 id={`analysis-${title}`}>{title}</h3>
        <p className="notice">
          Анализ пока не выполнен. Это не означает, что отзывов нет.
        </p>
      </section>
    );
  }

  const status = statusMessage(analysis);
  const snapshot = snapshotMessage(analysis);
  const confidence = confidenceLabel(analysis);
  const partial = isPartialView(analysis);

  return (
    <section className="section" aria-labelledby={`analysis-${title}`}>
      <div className="analysis-card__header">
        <h3 id={`analysis-${title}`}>{title}</h3>
        {confidence ? (
          <span className="badge">Уверенность: {confidence}</span>
        ) : null}
      </div>

      <p className="game-card__meta">{description}</p>

      {/* Полнота показывается всегда — скрывать её ради опрятности нельзя */}
      <div className={`coverage${partial ? ' coverage--warning' : ''}`}>
        <p className="coverage__line" style={{ margin: 0 }}>
          {coverageMessage(analysis)}
        </p>
        {snapshot ? <p className="coverage__line">{snapshot}</p> : null}
        {analysis.coverage === 'sample' ? (
          <p className="coverage__line">
            Выводы основаны на выборке и не отражают мнение всех авторов
          </p>
        ) : null}
      </div>

      {status ? <p className="notice">{status}</p> : null}

      {analysis.summary ? <p>{analysis.summary}</p> : null}

      <PointList items={analysis.liked} variant="liked" heading="Что понравилось" />
      <PointList
        items={analysis.disliked}
        variant="disliked"
        heading="Что не понравилось"
      />

      {analysis.themes.length > 0 ? (
        <>
          <h4>Основные темы</h4>
          <ul className="theme-list">
            {analysis.themes.map((theme, index) => (
              <li
                key={`theme-${index}`}
                className={`theme theme--${theme.sentiment}`}
                data-evidence-refs={theme.evidenceRefs.join(' ')}
              >
                <div className="theme__name">{theme.name}</div>
                <p className="theme__description">{theme.description}</p>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <p className="game-card__meta" style={{ marginTop: '1rem' }}>
        Модель: {analysis.model} · версия промпта: {analysis.promptVersion}
      </p>
    </section>
  );
}
