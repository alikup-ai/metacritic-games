import Link from 'next/link';
import type { GameListItem } from '@/lib/api/types';
import { safeImageUrl } from '@/lib/safe-url';
import { Score } from './Score';

/**
 * Карточка игры в каталоге.
 *
 * Весь текст выводится как содержимое JSX: React экранирует его сам.
 * dangerouslySetInnerHTML не используется — данные приходят из внешнего
 * источника и считаются недоверенными.
 */

function formatDate(value: string | null): string | null {
  if (!value) return null;

  // Дата приходит как YYYY-MM-DD — это календарная дата, а не момент
  // времени. Разбираем по частям, иначе часовой пояс сдвинет день.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;

  const [, year, month, day] = match;
  return `${day}.${month}.${year}`;
}

export function GameCard({ game }: { readonly game: GameListItem }): React.JSX.Element {
  const cover = safeImageUrl(game.coverUrl);
  const released = formatDate(game.releaseDate);

  return (
    <li className="game-card">
      <Link href={`/games/${game.id}`} className="game-card__link">
        {cover ? (
          // Обычный img, а не next/image: адреса внешние и заранее
          // неизвестны, оптимизация потребовала бы списка доменов.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={cover}
            alt={`Обложка игры «${game.title}»`}
            className="game-card__cover"
            loading="lazy"
          />
        ) : (
          <div className="game-card__cover game-card__cover--empty" aria-hidden="true">
            Нет обложки
          </div>
        )}

        <div className="game-card__body">
          <h3 className="game-card__title">{game.title}</h3>

          {game.developer ? (
            <p className="game-card__meta">{game.developer}</p>
          ) : (
            // Разработчик неизвестен — издатель сюда НЕ подставляется
            <p className="game-card__meta">Разработчик неизвестен</p>
          )}

          {released ? <p className="game-card__meta">{released}</p> : null}

          <div className="game-card__scores">
            <Score value={game.metascore} kind="metascore" />
            <Score value={game.userscore} kind="userscore" />
          </div>
        </div>
      </Link>
    </li>
  );
}
