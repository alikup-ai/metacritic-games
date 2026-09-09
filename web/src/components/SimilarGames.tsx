import Link from 'next/link';
import type { SimilarGame } from '@/lib/api/types';
import { safeImageUrl } from '@/lib/safe-url';

/**
 * Похожие игры.
 *
 * Показывается только причина сходства — числовая близость и веса
 * признаков пользователю не нужны и лишь загромождали бы карточку.
 *
 * При пустом списке компонент не отрисовывается вовсе: пустой раздел
 * создавал бы впечатление поломки.
 */
export function SimilarGames({
  games,
}: {
  readonly games: readonly SimilarGame[];
}): React.JSX.Element | null {
  if (games.length === 0) return null;

  return (
    <section className="section" aria-labelledby="similar-heading">
      <h3 id="similar-heading">Похожие игры</h3>

      <ul className="similar-list">
        {games.map((game) => {
          const cover = safeImageUrl(game.coverUrl);

          return (
            <li key={game.id} className="similar-item">
              <Link href={`/games/${game.id}`} className="similar-item__link">
                {cover ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={cover}
                    alt=""
                    className="similar-item__cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="similar-item__cover similar-item__cover--empty" aria-hidden="true" />
                )}

                <div className="similar-item__body">
                  <span className="similar-item__title">{game.title}</span>
                  {game.reasons.length > 0 ? (
                    <span className="similar-item__reason">{game.reasons[0]}</span>
                  ) : null}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
