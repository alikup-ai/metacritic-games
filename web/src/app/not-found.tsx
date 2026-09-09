import Link from 'next/link';

/** Страница «не найдено»: показывается и для отсутствующей игры. */
export default function NotFound(): React.JSX.Element {
  return (
    <div className="empty-state">
      <h2 className="empty-state__title">Страница не найдена</h2>
      <p>Возможно, игра была удалена или ссылка неверна.</p>
      <p>
        <Link href="/" className="button">
          Вернуться в каталог
        </Link>
      </p>
    </div>
  );
}
