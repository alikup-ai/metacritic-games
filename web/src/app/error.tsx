'use client';

import { useEffect } from 'react';

/**
 * Обработчик непредвиденных ошибок.
 *
 * Пользователю показывается общее сообщение: подробности ошибки могут
 * содержать сведения об устройстве системы.
 */
export default function Error({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}): React.JSX.Element {
  useEffect(() => {
    // В консоль браузера — только признак ошибки, без её содержимого
    console.error('Ошибка отображения страницы', error.digest ?? '');
  }, [error]);

  return (
    <div className="empty-state">
      <h2 className="empty-state__title">Что-то пошло не так</h2>
      <p>Не удалось отобразить страницу.</p>
      <p>
        <button type="button" className="button" onClick={reset}>
          Попробовать снова
        </button>
      </p>
    </div>
  );
}
