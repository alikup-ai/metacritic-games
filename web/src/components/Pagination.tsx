import Link from 'next/link';
import type { Pagination as PaginationData } from '@/lib/api/types';

/**
 * Постраничная навигация.
 *
 * Страницы запрашиваются у сервера: весь каталог в браузер не загружается.
 * Ссылки настоящие — работают в новой вкладке и без JavaScript.
 */

interface PaginationProps {
  readonly pagination: PaginationData;
  /** Текущие параметры запроса; номер страницы подставляется здесь. */
  readonly params: Record<string, string>;
}

function hrefFor(params: Record<string, string>, page: number): string {
  const search = new URLSearchParams(params);
  if (page > 1) search.set('page', String(page));
  else search.delete('page');

  const query = search.toString();
  return query ? `/?${query}` : '/';
}

export function Pagination({
  pagination,
  params,
}: PaginationProps): React.JSX.Element | null {
  const { page, totalPages } = pagination;

  // Одна страница — навигация не нужна
  if (totalPages <= 1) return null;

  const hasPrevious = page > 1;
  const hasNext = page < totalPages;

  return (
    <nav className="pagination" aria-label="Навигация по страницам">
      {hasPrevious ? (
        <Link
          className="button button--secondary"
          href={hrefFor(params, page - 1)}
          rel="prev"
        >
          ← Назад
        </Link>
      ) : (
        // Занимаем место, чтобы кнопки не смещались между страницами
        <span className="pagination__spacer" aria-hidden="true" />
      )}

      <span className="pagination__status" aria-live="polite">
        Страница {page} из {totalPages}
      </span>

      {hasNext ? (
        <Link
          className="button button--secondary"
          href={hrefFor(params, page + 1)}
          rel="next"
        >
          Вперёд →
        </Link>
      ) : (
        <span className="pagination__spacer" aria-hidden="true" />
      )}
    </nav>
  );
}
