import { cx } from './styles';

const VARIANTS = {
  neutral: 'bg-white/5 border border-specter-border text-specter-text-muted',
  live:    'bg-specter-state-success/15 border border-specter-state-success/40 text-emerald-300',
  warning: 'bg-specter-state-warning/15 border border-specter-state-warning/40 text-amber-300',
  count:   'bg-specter-primary-cyan text-specter-bg-deep font-semibold tabular-nums justify-center min-w-[18px]',
};

const DOT = {
  live: 'bg-specter-state-success animate-pulse',
  warning: 'bg-specter-state-warning',
};

/**
 * Small pill label.
 * variant: neutral | live | warning | count
 * `live` and `warning` show a leading dot; `live` with no children reads "Live".
 * `count` is a compact number bubble: <Badge variant="count">3</Badge>.
 */
export default function Badge({ variant = 'neutral', children, className = '', ...props }) {
  const isCount = variant === 'count';
  const content = children ?? (variant === 'live' ? 'Live' : null);
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-pill font-ui text-ui-xs whitespace-nowrap',
        isCount ? 'h-[18px] px-1.5' : 'h-5 px-2',
        VARIANTS[variant] || VARIANTS.neutral,
        className,
      )}
      {...props}
    >
      {DOT[variant] && <span aria-hidden="true" className={cx('h-1.5 w-1.5 rounded-pill', DOT[variant])} />}
      {content}
    </span>
  );
}
