/**
 * Состояние загрузки каталога.
 *
 * Каркас повторяет структуру карточек, чтобы страница не «прыгала»
 * при появлении данных.
 */
export default function Loading(): React.JSX.Element {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="visually-hidden">Загрузка каталога</span>
      <ul className="game-grid">
        {Array.from({ length: 8 }, (_, index) => (
          <li key={index} className="game-card">
            <div className="skeleton skeleton--card" />
            <div className="game-card__body">
              <div className="skeleton skeleton--text" style={{ width: '80%' }} />
              <div className="skeleton skeleton--text" style={{ width: '50%' }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
