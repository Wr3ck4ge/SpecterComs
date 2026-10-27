import { ChevronRight } from 'lucide-react';
import { cx, focusRing } from './styles';

/**
 * List row: icon + title + subtitle + trailing slot + chevron.
 * With `onClick` the row renders as a <button>, so don't put interactive
 * elements (Toggle, IconButton) in `trailing` of a clickable row — put them
 * on a non-clickable row instead.
 * chevron: defaults to true for clickable rows.
 * selected: highlights the row (sets aria-current).
 */
export default function Row({
  icon, title, subtitle, trailing, chevron, onClick, disabled = false, selected = false, className = '', ...props
}) {
  const clickable = typeof onClick === 'function';
  const showChevron = chevron ?? clickable;
  const Tag = clickable ? 'button' : 'div';

  return (
    <Tag
      {...(clickable ? { type: 'button', onClick, disabled } : {})}
      aria-current={selected ? 'true' : undefined}
      className={cx(
        'group w-full flex items-center gap-3 px-3 py-2 rounded-ui-row text-left font-ui transition-colors duration-150',
        clickable && 'hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed',
        clickable && focusRing,
        selected && 'bg-specter-primary-cyan/10',
        className,
      )}
      {...props}
    >
      {icon && (
        <span
          aria-hidden="true"
          className="h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-ui-sm bg-specter-primary-cyan/10 text-specter-primary-neon"
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-ui-base text-specter-text-main truncate">{title}</span>
        {subtitle && <span className="block text-ui-xs text-specter-text-subtle truncate">{subtitle}</span>}
      </span>
      {trailing && <span className="shrink-0 flex items-center gap-2 text-ui-sm text-specter-text-muted">{trailing}</span>}
      {showChevron && (
        <ChevronRight
          size={16}
          aria-hidden="true"
          className="shrink-0 text-specter-text-subtle group-hover:text-specter-text-main transition-colors"
        />
      )}
    </Tag>
  );
}
