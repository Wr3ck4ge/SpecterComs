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
