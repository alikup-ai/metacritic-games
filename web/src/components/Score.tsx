/**
 * Отображение оценки.
 *
 * Оценки не вычисляются: приходят с бэкенда как есть. Здесь только выбор
 * цвета и форматирование. null означает «оценки нет» и показывается как
 * прочерк, а не как ноль.
 */

export type ScoreKind = 'metascore' | 'userscore';

interface ScoreProps {
  readonly value: number | null;
  readonly kind: ScoreKind;
  /** Подпись; по умолчанию зависит от вида оценки. */
  readonly label?: string;
}

/**
 * Цветовая группа.
 *
 * Пороги соответствуют шкале Metacritic. Шкалы разные: у критиков 0–100,
 * у пользователей 0–10.
 */
function tone(value: number, kind: ScoreKind): 'high' | 'mid' | 'low' {
  const normalized = kind === 'userscore' ? value * 10 : value;
  if (normalized >= 75) return 'high';
  if (normalized >= 50) return 'mid';
  return 'low';
}

function formatValue(value: number, kind: ScoreKind): string {
  // Пользовательская оценка дробная, оценка критиков — целая
  return kind === 'userscore' ? value.toFixed(1).replace('.', ',') : String(value);
}

export function Score({ value, kind, label }: ScoreProps): React.JSX.Element {
  const caption = label ?? (kind === 'metascore' ? 'Критики' : 'Игроки');

  if (value === null) {
    return (
      <span className="score score--none">
        <span className="score__value" aria-hidden="true">
          —
        </span>
        <span className="score__label">{caption}</span>
        <span className="visually-hidden">{caption}: оценки нет</span>
      </span>
    );
  }

  const formatted = formatValue(value, kind);

  return (
    <span className={`score score--${tone(value, kind)}`}>
      <span className="score__value" aria-hidden="true">
        {formatted}
      </span>
      <span className="score__label">{caption}</span>
      <span className="visually-hidden">
        {caption}: {formatted} из {kind === 'userscore' ? '10' : '100'}
      </span>
    </span>
  );
}
