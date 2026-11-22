import { StarIcon } from '../icons';

export function Stars({
  value,
  onChange,
  disabled,
  size = 'md',
}: {
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
}) {
  return (
    <div className={`stars ${size}`} role="group" aria-label="Star rating">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          className={n <= value ? 'on' : ''}
          disabled={disabled}
          // Tapping the current rating again clears it.
          onClick={() => onChange(n === value ? 0 : n)}
          aria-label={`${n} star${n > 1 ? 's' : ''}`}
          aria-pressed={n <= value}
        >
          <StarIcon filled={n <= value} />
        </button>
      ))}
    </div>
  );
}
