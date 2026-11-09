import { forwardRef } from 'react';
import { cx, focusRing } from './styles';

const VARIANTS = {
  ghost:     'text-specter-text-muted hover:text-specter-text-main hover:bg-white/5',
  secondary: 'text-specter-text-muted hover:text-specter-text-main bg-specter-bg-panel/80 border border-specter-border hover:border-specter-border-strong',
  danger:    'text-red-300 hover:text-red-200 hover:bg-specter-state-error/15',
};

const SIZES = {
  sm: 'h-7 w-7',
  md: 'h-8 w-8',
};

/**
 * Square icon-only button. `label` is required: it becomes aria-label and
 * the hover tooltip.
 * variant: ghost | secondary | danger
 * size:    sm (28px) | md (32px)
 * active:  shows the pressed/selected state (sets aria-pressed)
 */
const IconButton = forwardRef(function IconButton(
  { icon, label, variant = 'ghost', size = 'md', active, type = 'button', className = '', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={active === undefined ? undefined : active}
      className={cx(
        'inline-flex items-center justify-center shrink-0 rounded-ui-row transition-colors duration-150',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        focusRing,
        VARIANTS[variant] || VARIANTS.ghost,
        SIZES[size] || SIZES.md,
        active && 'text-specter-primary-neon bg-specter-primary-cyan/15',
        className,
      )}
      {...props}
    >
      <span aria-hidden="true" className="inline-flex">{icon}</span>
    </button>
  );
});

export default IconButton;
