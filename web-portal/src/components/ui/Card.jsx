import { cx, glassPanel } from './styles';

const PADDING = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',
};

/**
 * Rounded glass panel.
 * title / subtitle / actions: optional header (actions sit top-right).
 * padding: none | sm | md | lg — use `none` when the body is a list of Rows.
 * as: element type (default div), e.g. "section".
 */
export default function Card({ as: Tag = 'div', title, subtitle, actions, padding = 'md', className = '', children, ...props }) {
  const hasHeader = title || subtitle || actions;
  return (
    <Tag className={cx('rounded-ui-lg font-ui text-specter-text-main', glassPanel, PADDING[padding] ?? PADDING.md, className)} {...props}>
      {hasHeader && (
        <div className={cx('flex items-start justify-between gap-3', children && 'mb-3', padding === 'none' && 'px-4 pt-4')}>
          <div className="min-w-0">
            {title && <h3 className="text-ui-lg font-semibold text-specter-text-main truncate">{title}</h3>}
            {subtitle && <p className="text-ui-sm text-specter-text-subtle">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-1.5 shrink-0">{actions}</div>}
        </div>
      )}
      {children}
    </Tag>
  );
}
