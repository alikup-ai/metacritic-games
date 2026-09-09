import Link from 'next/link';

/**
 * Страница «игра не найдена».
 *
 * Отдельная граница для сегмента: отсутствие игры объясняется в терминах
 * каталога, а не общим сообщением сайта.
 *
 * Next.js добавляет сюда <meta name="robots" content="noindex">, поэтому
 * страница не попадает в поисковую выдачу даже при коде 200.
 */
export default function GameNotFound(): React.JSX.Element {
  return (
    <div className="empty-state">
      <h2 className="empty-state__title">Страница не найдена</h2>
      <p>Игра не найдена. Возможно, она была удалена или ссылка неверна.</p>
      <p>
        <Link href="/" className="button">
          Вернуться в каталог
        </Link>
      </p>
    </div>
  );
}
