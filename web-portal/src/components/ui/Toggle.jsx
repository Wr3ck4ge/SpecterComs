import { useId } from 'react';
import { cx, focusRing } from './styles';

/**
 * Pill on/off switch. Controlled: pass `checked` and `onChange(nextChecked)`.
 * Rendered as a <button role="switch">, so Space/Enter toggle it natively.
 * With `label` (and optional `description`) it lays out as a settings line:
 * text on the left, switch on the right. Without a label, pass `aria-label`.
 */
export default function Toggle({ checked, onChange, label, description, disabled = false, id, className = '', ...props }) {
  const autoId = useId();
  const switchId = id || autoId;
  const labelId = `${switchId}-label`;
  const descId = `${switchId}-desc`;

  const control = (
    <button
      id={switchId}
      type="button"
      role="switch"
      aria-checked={!!checked}
      aria-labelledby={label ? labelId : undefined}
      aria-describedby={description ? descId : undefined}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={cx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-pill border transition-colors duration-150',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        focusRing,
        checked
          ? 'bg-specter-primary-cyan border-specter-primary-cyan'
          : 'bg-white/10 border-specter-border',
        !label && className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cx(
          'inline-block h-3.5 w-3.5 rounded-pill shadow transition-transform duration-150',
          checked ? 'translate-x-[18px] bg-specter-bg-deep' : 'translate-x-[2px] bg-specter-text-muted',
        )}
      />
    </button>
  );

  if (!label) return control;

  return (
    <div className={cx('flex items-center justify-between gap-4 font-ui', className)}>
      <div className="min-w-0">
        <label id={labelId} htmlFor={switchId} className={cx('block text-ui-base text-specter-text-main', !disabled && 'cursor-pointer')}>
          {label}
        </label>
        {description && (
          <p id={descId} className="text-ui-xs text-specter-text-subtle">{description}</p>
        )}
      </div>
      {control}
    </div>
  );
}
