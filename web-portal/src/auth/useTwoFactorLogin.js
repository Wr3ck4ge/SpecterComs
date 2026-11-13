// L3: state for the login's two-factor step, shared by the main window's
// AuthScreen and the tray strip's login. session.login() answers
// { twoFactor: { challenge } } when the account has 2FA on; begin() switches
// LoginForm to the code step (pass `twoFactor` to it), submit() finishes the
// sign-in with session.verifyTwoFactor().
import { useCallback, useState } from 'react';
import * as session from './session.js';

export default function useTwoFactorLogin() {
  const [step, setStep] = useState(null); // { challenge, code, useRecovery } | null

  const begin = useCallback((challenge) => setStep({ challenge, code: '', useRecovery: false }), []);
  const cancel = useCallback(() => setStep(null), []);

  /** -> { user, error }. A timed-out challenge drops back to the password step. */
  const submit = useCallback(async () => {
    if (!step) return { user: null, error: 'Sign in again.' };
    const value = step.code.trim();
    const res = await session.verifyTwoFactor(step.useRecovery
      ? { challenge: step.challenge, recovery_code: value }
      : { challenge: step.challenge, code: value });
    if (res.error) {
      if (res.code === 'TWO_FACTOR_CHALLENGE_EXPIRED') setStep(null);
      else setStep((s) => (s ? { ...s, code: '' } : s));
      return { user: null, error: res.error };
    }
    setStep(null);
    return { user: res.user, error: null, recoveryCodesRemaining: res.recoveryCodesRemaining };
  }, [step]);

  const twoFactor = step && {
    code: step.code,
    useRecovery: step.useRecovery,
    onCodeChange: (e) => { const v = e.target.value; setStep((s) => (s ? { ...s, code: v } : s)); },
    onToggleRecovery: () => setStep((s) => (s ? { ...s, code: '', useRecovery: !s.useRecovery } : s)),
    onCancel: cancel,
  };

  return { active: Boolean(step), begin, cancel, submit, twoFactor: twoFactor || null };
}
