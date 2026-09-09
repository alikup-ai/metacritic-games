import { CatalogFilters } from '@/components/CatalogFilters';
import { GameCard } from '@/components/GameCard';
import { Pagination } from '@/components/Pagination';
import { ApiRequestError, fetchGames, fetchPlatforms } from '@/lib/api/client';
import {
  SORT_FIELDS,
  SORT_ORDERS,
  type PlatformOption,
  type SortField,
  type SortOrder,
} from '@/lib/api/types';

/**
 * Страница каталога.
 *
 * Серверный компонент: обращение к API выполняется на сервере, в браузер
 * уходит готовая разметка. Адрес бэкенда и заголовки в клиентский пакет
 * не попадают.
 *
 * Отбор, сортировка и подсчёт выполняются сервером — каталог целиком
 * в браузер не загружается.
 */

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Первое значение параметра: повтор в адресе не должен ломать разбор. */
function single(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

/**
 * Приводит параметр к допустимому значению.
 *
 * Некорректное значение в адресе не должно приводить к ошибке: страница
 * открывается со значением по умолчанию. Проверку всё равно повторит API.
 */
function pickEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function pickPage(value: string): number {
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 ? page : 1;
}

export default async function CatalogPage({
  searchParams,
}: PageProps): Promise<React.JSX.Element> {
  const params = await searchParams;

  const q = single(params.q).slice(0, 100);
  const platform = single(params.platform);
  const sort: SortField = pickEnum(single(params.sort), SORT_FIELDS, 'metascore');
  const order: SortOrder = pickEnum(single(params.order), SORT_ORDERS, 'desc');
  const page = pickPage(single(params.page));

  // Список платформ не критичен: без него каталог всё равно показывается
  let platforms: readonly PlatformOption[] = [];
  try {
    platforms = (await fetchPlatforms()).items;
  } catch {
    platforms = [];
  }

  const filters = { q, platform, sort, order };

  let result;
  try {
    result = await fetchGames({
      page,
      ...(q ? { q } : {}),
      ...(platform ? { platform } : {}),
      sort,
      order,
    });
  } catch (error) {
    const message =
      error instanceof ApiRequestError
        ? error.message
        : 'Не удалось загрузить каталог';

    return (
      <>
        <CatalogFilters platforms={platforms} current={filters} />
        <div className="empty-state">
          <h2 className="empty-state__title">Данные недоступны</h2>
          <p>{message}</p>
          <p>Попробуйте обновить страницу позже.</p>
        </div>
      </>
    );
  }

  // Параметры для ссылок пагинации
  const linkParams: Record<string, string> = {};
  if (q) linkParams.q = q;
  if (platform) linkParams.platform = platform;
  if (sort !== 'metascore') linkParams.sort = sort;
  if (order !== 'desc') linkParams.order = order;

  return (
    <>
      <CatalogFilters platforms={platforms} current={filters} />

      {result.items.length === 0 ? (
        <div className="empty-state">
          <h2 className="empty-state__title">Ничего не найдено</h2>
          <p>
            {q || platform
              ? 'Попробуйте изменить условия поиска или сбросить фильтры.'
              : 'Каталог пока пуст — данные появятся после первого обхода источника.'}
          </p>
        </div>
      ) : (
        <>
          <p className="pagination__status" role="status">
            Найдено игр: {result.pagination.total.toLocaleString('ru-RU')}
          </p>

          <ul className="game-grid">
            {result.items.map((game) => (
              <GameCard key={game.id} game={game} />
            ))}
          </ul>

          <Pagination pagination={result.pagination} params={linkParams} />
        </>
      )}
    </>
  );
}
