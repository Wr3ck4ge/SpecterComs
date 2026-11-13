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
 * onResendVerification()      when given, the error Alert gets a "Resend email" link
 *                             (EMAIL_NOT_VERIFIED); resendNote shows its outcome
 * autoFocus                   focus the email field on mount (default true)
 * idPrefix                    prefix for input ids, if two forms share a page
 * twoFactor                   L3: when set, the form is the second step instead:
 *                             { code, onCodeChange(event), useRecovery,
 *                               onToggleRecovery(), onCancel() }; onSubmit
 *                             then submits the code
 */
export default function LoginForm(props) {
  if (props.twoFactor) return <TwoFactorStep {...props} />;
  return <PasswordStep {...props} />;
}

function TwoFactorStep({ twoFactor, onSubmit, loading = false, error = null, compact = false, idPrefix = 'login' }) {
  const { code, onCodeChange, useRecovery, onToggleRecovery, onCancel } = twoFactor;
  return (
    <form onSubmit={onSubmit} className={cx('font-ui', compact ? 'space-y-3' : 'space-y-4')} aria-busy={loading || undefined}>
      <p className="text-ui-sm text-specter-text-muted">
        {useRecovery
          ? 'Enter one of the recovery codes you saved when you turned on two-factor authentication. Each works once.'
          : 'Enter the 6-digit code from your authenticator app.'}
      </p>
      <Input
        label={useRecovery ? 'Recovery code' : 'Authentication code'}
        id={`${idPrefix}-2fa-code`}
        type="text"
        value={code}
        onChange={onCodeChange}
        placeholder={useRecovery ? 'XXXX-XXXX-XXXX' : '123456'}
        inputMode={useRecovery ? 'text' : 'numeric'}
        autoComplete="one-time-code"
        maxLength={useRecovery ? 20 : 7}
        required
        autoFocus
      />
      {error && <Alert variant="error">{error}</Alert>}
      <Button type="submit" full disabled={loading || !String(code || '').trim()}>
        {loading ? 'Checking…' : 'Verify'}
      </Button>
      <div className="flex items-center justify-between gap-3">
        <TextLink onClick={onToggleRecovery} disabled={loading}>
          {useRecovery ? 'Use an authenticator code' : 'Use a recovery code'}
        </TextLink>
        <TextLink onClick={onCancel} disabled={loading}>Back</TextLink>
      </div>
    </form>
  );
}

function PasswordStep({
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
  onResendVerification,
  resendNote = null,
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

      {error && (
        <Alert variant="error">
          {error}
          {onResendVerification && (
            <>
              {' '}<TextLink onClick={onResendVerification} disabled={loading}>Resend email</TextLink>
              {resendNote && <div className="mt-1 opacity-80">{resendNote}</div>}
            </>
          )}
        </Alert>
      )}
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
