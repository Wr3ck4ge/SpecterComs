import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { cx } from './styles';

const VARIANTS = {
  error:   { box: 'bg-specter-state-error/10 border-specter-state-error/40 text-red-300',         Icon: XCircle },
  success: { box: 'bg-specter-state-success/10 border-specter-state-success/40 text-emerald-300', Icon: CheckCircle2 },
  warning: { box: 'bg-specter-state-warning/10 border-specter-state-warning/40 text-amber-300',   Icon: AlertTriangle },
  info:    { box: 'bg-specter-primary-cyan/10 border-specter-border-strong text-specter-text-main', Icon: Info },
};

/**
 * Inline notice for form errors and confirmations.
 * variant: error | success | warning | info
 * title:   optional bold first line
 * icon:    false hides the leading icon
 * `error` is announced immediately (role="alert"); the others politely (role="status").
 */
export default function Alert({ variant = 'error', title, icon = true, className = '', children, ...props }) {
  const { box, Icon } = VARIANTS[variant] || VARIANTS.error;
  return (
    <div
      role={variant === 'error' ? 'alert' : 'status'}
      className={cx('flex items-start gap-2 rounded-ui-row border px-3 py-2 font-ui text-ui-sm', box, className)}
      {...props}
    >
      {icon && <Icon size={16} aria-hidden="true" className="shrink-0 mt-px" />}
      <div className="min-w-0 break-words">
        {title && <div className="font-semibold">{title}</div>}
        {children}
      </div>
    </div>
  );
}
