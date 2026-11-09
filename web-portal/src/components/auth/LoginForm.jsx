import { Alert, Button, Input } from '../ui';
import { cx } from '../ui/styles';
import { TextLink } from './AuthLayout';

/**
 * Email + password login form. Presentational: the caller owns the field
 * values and the submit logic (AuthScreen in App.jsx today).
 *
 * email, password             controlled values
 * onEmailChange(event)        input change handlers (receive the change event)
 * onPasswordChange(event)
 * onSubmit(event)             form submit (Enter in any field, or the button);
 *                             call event.preventDefault() yourself
 * loading                     disables the submit button and shows "Logging in…"
 * error / notice              error Alert / success Alert (e.g. "registered, please log in")
 * compact                     tight layout for the ~360px tray strip: smaller gaps,
 *                             links in a row under the button
 * onForgotPassword()          shows a "Forgot password?" link when given
 * onCreateAccount()           shows a "Create account" link when given
 * autoFocus                   focus the email field on mount (default true)
 * idPrefix                    prefix for input ids, if two forms share a page
 */
export default function LoginForm({
  email,
  password,
  onEmailChange,
  onPasswordChange,
  onSubmit,
  loading = false,
  error = null,
  notice = null,
  compact = false,
  onForgotPassword,
  onCreateAccount,
  autoFocus = true,
  idPrefix = 'login',
}) {
  const forgotLink = onForgotPassword && (
    <TextLink onClick={onForgotPassword} disabled={loading}>Forgot password?</TextLink>
  );
  const createLink = onCreateAccount && (
    <TextLink onClick={onCreateAccount} disabled={loading}>Create account</TextLink>
  );

  return (
    <form onSubmit={onSubmit} className={cx('font-ui', compact ? 'space-y-3' : 'space-y-4')} aria-busy={loading || undefined}>
      <Input
        label="Email"
        id={`${idPrefix}-email`}
        type="email"
        value={email}
        onChange={onEmailChange}
        placeholder="email@example.com"
        required
        autoComplete="email"
        autoFocus={autoFocus}
      />

      <div className="space-y-1.5">
        <Input
          label="Password"
          id={`${idPrefix}-password`}
          type="password"
          value={password}
          onChange={onPasswordChange}
          placeholder="Your password"
          required
          autoComplete="current-password"
        />
        {!compact && forgotLink && <div className="text-right">{forgotLink}</div>}
      </div>

      {error && <Alert variant="error">{error}</Alert>}
      {notice && <Alert variant="success">{notice}</Alert>}

      <Button type="submit" full disabled={loading}>
        {loading ? 'Logging in…' : 'Log in'}
      </Button>

      {(compact ? (forgotLink || createLink) : createLink) && (
        <div className={cx('flex items-center gap-3', compact && forgotLink && createLink ? 'justify-between' : 'justify-center')}>
          {compact && forgotLink}
          {createLink && (
            compact ? createLink : (
              <span className="text-ui-sm text-specter-text-subtle">New here? {createLink}</span>
            )
          )}
        </div>
      )}
    </form>
  );
}
