import nodemailer from 'nodemailer';

function createTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true', // true for port 465
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

export async function sendPasswordResetEmail(toEmail: string, resetToken: string): Promise<void> {
  const frontendUrl = process.env.FRONTEND_URL || 'https://spectercoms.net';
  const resetUrl = `${frontendUrl}/reset-password?token=${resetToken}`;
  const from = process.env.SMTP_FROM || '"SpecterComs" <noreply@spectercoms.net>';

  const transporter = createTransport();

  await transporter.sendMail({
    from,
    to: toEmail,
    subject: 'SpecterComs — Password Reset',
    html: `
      <div style="font-family: monospace; background: #0a0a0a; color: #e0e0e0; padding: 32px; max-width: 520px; margin: 0 auto; border: 1px solid #222;">
        <div style="color: #06b6d4; font-size: 18px; font-weight: bold; letter-spacing: 4px; text-transform: uppercase; margin-bottom: 24px;">
          SPECTERCOMS // PASSWORD RESET
        </div>
        <p style="color: #a0a0a0; line-height: 1.6;">
          A password reset was requested for your SpecterComs account. Click the link below to set a new password. This link expires in <strong style="color: #e0e0e0;">1 hour</strong>.
        </p>
        <div style="margin: 32px 0; text-align: center;">
          <a href="${resetUrl}"
             style="display: inline-block; background: #06b6d4; color: #000; font-weight: bold; letter-spacing: 2px; text-transform: uppercase; padding: 14px 32px; text-decoration: none;">
            Reset Password
          </a>
        </div>
        <p style="color: #555; font-size: 12px; line-height: 1.6;">
          If you did not request this, you can safely ignore this email. Your password will not change.
          <br/><br/>
          Or copy this link: <a href="${resetUrl}" style="color: #06b6d4;">${resetUrl}</a>
        </p>
        <div style="border-top: 1px solid #222; margin-top: 24px; padding-top: 16px; color: #333; font-size: 11px;">
          SpecterComs — Zero-Trust Voice Network
        </div>
      </div>
    `,
    text: `SpecterComs Password Reset\n\nClick the link to reset your password (expires in 1 hour):\n${resetUrl}\n\nIf you did not request this, ignore this email.`,
  });
}

/** True when an SMTP provider is configured; callers degrade gracefully otherwise. */
export function isMailerConfigured(): boolean {
  return !!process.env.SMTP_HOST;
}

function shell(title: string, bodyHtml: string): string {
  return `
      <div style="font-family: monospace; background: #0a0a0a; color: #e0e0e0; padding: 32px; max-width: 520px; margin: 0 auto; border: 1px solid #222;">
        <div style="color: #06b6d4; font-size: 18px; font-weight: bold; letter-spacing: 4px; text-transform: uppercase; margin-bottom: 24px;">
          SPECTERCOMS // ${title}
        </div>
        ${bodyHtml}
        <div style="border-top: 1px solid #222; margin-top: 24px; padding-top: 16px; color: #333; font-size: 11px;">
          SpecterComs - Zero-Trust Voice Network
        </div>
      </div>`;
}

/** Sends the verification link. Returns false (never throws) when mail is unavailable. */
export async function sendVerificationEmail(toEmail: string, token: string): Promise<boolean> {
  if (!isMailerConfigured()) {
    console.warn('[email] SMTP_HOST not set; verification email not sent');
    return false;
  }
  try {
    const frontendUrl = process.env.FRONTEND_URL || 'https://spectercoms.net';
    const url = `${frontendUrl}/verify-email?token=${token}`;
    const from = process.env.SMTP_FROM || '"SpecterComs" <noreply@spectercoms.net>';
    await createTransport().sendMail({
      from,
      to: toEmail,
      subject: 'SpecterComs - Verify your email',
      html: shell('VERIFY EMAIL', `
        <p style="color: #a0a0a0; line-height: 1.6;">Confirm this email address for your SpecterComs account. The link expires in <strong style="color: #e0e0e0;">24 hours</strong>.</p>
        <div style="margin: 32px 0; text-align: center;">
          <a href="${url}" style="display: inline-block; background: #06b6d4; color: #000; font-weight: bold; letter-spacing: 2px; text-transform: uppercase; padding: 14px 32px; text-decoration: none;">Verify Email</a>
        </div>
        <p style="color: #555; font-size: 12px; line-height: 1.6;">If you did not create or change an account, ignore this email.<br/><br/>Or copy this link: <a href="${url}" style="color: #06b6d4;">${url}</a></p>`),
      text: `Verify your SpecterComs email (expires in 24 hours):\n${url}\n\nIf this wasn't you, ignore this email.`,
    });
    return true;
  } catch (err) {
    console.warn('[email] verification email failed:', (err as Error)?.message);
    return false;
  }
}

/** Tells the OLD address that a change to a new one was requested. Never throws. */
export async function sendEmailChangeNotice(toOldEmail: string): Promise<boolean> {
  if (!isMailerConfigured()) return false;
  try {
    const from = process.env.SMTP_FROM || '"SpecterComs" <noreply@spectercoms.net>';
    await createTransport().sendMail({
      from,
      to: toOldEmail,
      subject: 'SpecterComs - Email change requested',
      html: shell('EMAIL CHANGE', `<p style="color: #a0a0a0; line-height: 1.6;">A change of the email address on your SpecterComs account was requested. It only takes effect once the new address is verified; until then this address stays in use. If this was not you, change your password now.</p>`),
      text: 'A change of the email address on your SpecterComs account was requested. It only takes effect once the new address is verified. If this was not you, change your password now.',
    });
    return true;
  } catch (err) {
    console.warn('[email] change notice failed:', (err as Error)?.message);
    return false;
  }
}

/** L12: tells the user the outcome of their ban appeal. Never throws; false when mail is unavailable. */
export async function sendAppealDecisionEmail(toEmail: string, overturned: boolean, note: string | null): Promise<boolean> {
  if (!isMailerConfigured()) return false;
  try {
    const from = process.env.SMTP_FROM || '"SpecterComs" <noreply@spectercoms.net>';
    const verdict = overturned
      ? 'Your appeal was successful. The action on your account has been reversed and you can sign in again.'
      : 'Your appeal was reviewed and the action on your account stands.';
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
    await createTransport().sendMail({
      from,
      to: toEmail,
      subject: 'SpecterComs - Your appeal decision',
      html: shell('APPEAL DECISION', `<p style="color: #a0a0a0; line-height: 1.6;">${verdict}</p>${note ? `<p style="color: #a0a0a0; line-height: 1.6;">Note from the reviewer: ${esc(note)}</p>` : ''}`),
      text: `${verdict}${note ? `\n\nNote from the reviewer: ${note}` : ''}`,
    });
    return true;
  } catch (err) {
    console.warn('[email] appeal decision failed:', (err as Error)?.message);
    return false;
  }
}
