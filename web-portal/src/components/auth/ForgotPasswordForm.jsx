import { ArrowLeft } from 'lucide-react';
import { Alert, Button, Input } from '../ui';
import { cx } from '../ui/styles';
import { TextLink } from './AuthLayout';

/**
 * "Reset your password" form. Presentational, like LoginForm: the caller
 * owns the email value and the submit (session.forgotPassword). Used by the
 * main window's AuthScreen and the tray strip's forgot-password cabinet.
 *
 * email, onEmailChange(event)  controlled value + change handler
 * onSubmit(event)              call event.preventDefault() yourself
 * loading / error / success    state; the button stays disabled after success
 * onBack()                     "Back to login" link
 * compact                      tighter spacing for the strip
 * autoFocus                    focus the email field on mount (default true)
 */
export default function ForgotPasswordForm({
  email,
  onEmailChange,
  onSubmit,
  loading = false,
  error = null,
  success = null,
  onBack,
  compact = false,
  autoFocus = true,
}) {
  const gap = compact ? 'space-y-3' : 'space-y-4';
  return (
    <div className={cx('font-ui', gap)}>
      <div className="space-y-1">
        <h2 className="text-ui-lg font-semibold text-specter-text-main">Reset your password</h2>
        <p className="text-ui-sm text-specter-text-subtle">
          Enter the email associated with your account. If it exists, a reset link will be sent.
        </p>
      </div>
      <form onSubmit={onSubmit} className={gap} aria-busy={loading || undefined}>
        <Input label="Email" id="forgot-email" type="email" value={email} onChange={onEmailChange}
          placeholder="email@example.com" required autoComplete="email" autoFocus={autoFocus} />
        {error   && <Alert variant="error">{error}</Alert>}
        {success && <Alert variant="success">{success}</Alert>}
        <Button type="submit" full disabled={loading || !!success}>
          {loading ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>
      {onBack && (
        <div className="text-center">
          <TextLink onClick={onBack} className="inline-flex items-center gap-1">
            <ArrowLeft size={14} aria-hidden="true" /> Back to login
          </TextLink>
        </div>
      )}
    </div>
  );
}
