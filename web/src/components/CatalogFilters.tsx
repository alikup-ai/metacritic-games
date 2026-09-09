'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useId, useState } from 'react';
import type { PlatformOption, SortField, SortOrder } from '@/lib/api/types';

/**
 * Панель фильтров каталога.
 *
 * Состояние живёт в адресе страницы, а не в компоненте: так фильтр можно
 * сохранить в закладки, отправить ссылкой и вернуться кнопкой «назад».
 * Отбор и подсчёт выполняет сервер — каталог целиком в браузер не грузится.
 */

const SORT_LABELS: Record<SortField, string> = {
  metascore: 'Оценка критиков',
  userscore: 'Оценка игроков',
  releaseDate: 'Дата выхода',
  title: 'Название',
};

interface CatalogFiltersProps {
  readonly platforms: readonly PlatformOption[];
  readonly current: {
    readonly q: string;
    readonly platform: string;
    readonly sort: SortField;
    readonly order: SortOrder;
  };
}

export function CatalogFilters({
  platforms,
  current,
}: CatalogFiltersProps): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const searchId = useId();
  const platformId = useId();
  const sortId = useId();
  const orderId = useId();

  const [query, setQuery] = useState(current.q);

  // Адрес может измениться извне — например, кнопкой «назад»
  useEffect(() => {
    setQuery(current.q);
  }, [current.q]);

  const navigate = useCallback(
    (changes: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString());

      for (const [key, value] of Object.entries(changes)) {
        if (value === '') params.delete(key);
        else params.set(key, value);
      }

      // Любое изменение фильтра возвращает к первой странице: иначе
      // можно оказаться на несуществующей странице нового результата.
      params.delete('page');

      const search = params.toString();
      router.push(search ? `/?${search}` : '/');
    },
    [router, searchParams],
  );

  return (
    <search className="filters">
      <form
        className="filters__row"
        onSubmit={(event) => {
          event.preventDefault();
          navigate({ q: query.trim() });
        }}
        role="search"
      >
        <div className="field">
          <label className="field__label" htmlFor={searchId}>
            Поиск по названию
          </label>
          <input
            id={searchId}
            type="search"
            name="q"
            value={query}
            placeholder="Например: Witcher"
            maxLength={100}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor={platformId}>
            Платформа
          </label>
          <select
            id={platformId}
            name="platform"
            value={current.platform}
            onChange={(event) => navigate({ platform: event.target.value })}
          >
            <option value="">Все платформы</option>
            {platforms.map((platform) => (
              <option key={platform.slug} value={platform.slug}>
                {platform.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={sortId}>
            Сортировка
          </label>
          <select
            id={sortId}
            name="sort"
            value={current.sort}
            onChange={(event) => navigate({ sort: event.target.value })}
          >
            {Object.entries(SORT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={orderId}>
            Порядок
          </label>
          <select
            id={orderId}
            name="order"
            value={current.order}
            onChange={(event) => navigate({ order: event.target.value })}
          >
            <option value="desc">По убыванию</option>
            <option value="asc">По возрастанию</option>
          </select>
        </div>

        <button type="submit" className="button">
          Найти
        </button>
      </form>
    </search>
  );
}
