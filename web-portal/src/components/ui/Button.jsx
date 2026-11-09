import { forwardRef } from 'react';
import { cx, focusRing } from './styles';

const VARIANTS = {
  primary:   'bg-specter-primary-cyan text-specter-bg-deep hover:bg-specter-primary-neon',
  secondary: 'bg-specter-bg-panel/80 text-specter-text-main border border-specter-border hover:border-specter-border-strong hover:bg-specter-bg-panel',
  ghost:     'text-specter-primary-neon hover:bg-white/5',
  danger:    'bg-specter-state-error/15 text-red-300 border border-specter-state-error/40 hover:bg-specter-state-error/25 hover:text-red-200',
};

const SIZES = {
  sm: 'h-8 px-3 text-ui-sm gap-1.5',
  md: 'h-9 px-4 text-ui-base gap-2',
};

/**
 * variant: primary | secondary | ghost | danger
 * size:    sm | md
 * icon:    optional leading element (e.g. <Plus size={14} />)
 * full:    stretch to container width
 * Other props (onClick, aria-*, form, ...) go to the <button>.
 */
const Button = forwardRef(function Button(
  { children, variant = 'primary', size = 'md', icon = null, full = false, type = 'button', className = '', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        'inline-flex items-center justify-center font-ui font-semibold rounded-ui-row transition-colors duration-150 select-none',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        focusRing,
        VARIANTS[variant] || VARIANTS.primary,
        SIZES[size] || SIZES.md,
        full && 'w-full',
        className,
      )}
      {...props}
    >
      {icon && <span className="shrink-0 inline-flex" aria-hidden="true">{icon}</span>}
      {children}
    </button>
  );
});

export default Button;
