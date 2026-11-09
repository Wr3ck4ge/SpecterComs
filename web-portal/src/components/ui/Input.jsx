import { forwardRef, useId, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cx, focusRing } from './styles';

/**
 * Text input with optional label, hint and error.
 * type="password" adds a show/hide toggle.
 * `error` replaces the hint and marks the field aria-invalid.
 * Other props (value, onChange, placeholder, autoComplete, ...) go to the <input>.
 */
const Input = forwardRef(function Input(
  { label, hint, error, id, type = 'text', className = '', inputClassName = '', ...props },
  ref,
) {
  const autoId = useId();
  const inputId = id || autoId;
  const noteId = `${inputId}-note`;
  const [revealed, setRevealed] = useState(false);
  const isPassword = type === 'password';
  const note = error || hint;

  return (
    <div className={cx('flex flex-col gap-1.5 font-ui', className)}>
      {label && (
        <label htmlFor={inputId} className="text-ui-sm font-medium text-specter-text-muted">
          {label}
        </label>
      )}
      <div className="relative">
        <input
          ref={ref}
          id={inputId}
          type={isPassword && revealed ? 'text' : type}
          aria-invalid={error ? true : undefined}
          aria-describedby={note ? noteId : undefined}
          className={cx(
            'w-full h-9 px-3 rounded-ui-row text-ui-base text-specter-text-main placeholder:text-specter-text-subtle',
            'bg-specter-bg-deep/60 border transition-colors duration-150',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            error
              ? 'border-specter-state-error/70 focus:border-specter-state-error'
              : 'border-specter-border hover:border-specter-border-strong focus:border-specter-primary-cyan',
            'focus:outline-none',
            isPassword && 'pr-10',
            inputClassName,
          )}
          {...props}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            aria-label={revealed ? 'Hide password' : 'Show password'}
            aria-pressed={revealed}
            className={cx(
              'absolute right-1.5 top-1/2 -translate-y-1/2 h-7 w-7 inline-flex items-center justify-center rounded-ui-sm',
              'text-specter-text-subtle hover:text-specter-text-main transition-colors',
              focusRing,
            )}
          >
            {revealed ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        )}
      </div>
      {note && (
        <span id={noteId} className={cx('text-ui-xs', error ? 'text-red-400' : 'text-specter-text-subtle')}>
          {note}
        </span>
      )}
    </div>
  );
});

export default Input;
