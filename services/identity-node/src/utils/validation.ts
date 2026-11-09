import { z } from 'zod';

export const registerSchema = z.object({
  callsign: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_]+$/, "Alphanumeric and underscores only"),
  email: z.string().email(),
  password: z.string().min(8).max(100),
  global_tag: z.string().max(16).optional(),
  hwid: z.string().optional(),
  timezone: z.string().optional(),
});

export const loginSchema = z.object({
  callsign: z.string().optional(),
  email: z.string().email().optional(),
  password: z.string().min(1),
  hwid: z.string().optional(),
}).refine(data => data.callsign || data.email, {
  message: "Either callsign or email must be provided",
  path: ["callsign"],
});

export type RegisterInput = z.infer<typeof registerSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(64).max(64),
  password: z.string().min(8).max(100),
});

export const refreshSchema = z.object({
  refresh_token: z.string().min(1),
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;

export const createOrgSchema = z.object({
  callsign: z.string().min(3).max(64),
  description: z.string().optional(),
  is_public: z.boolean().optional(),
  join_method: z.number().int().min(0).max(2).optional(), // 0=Open, 1=Application, 2=Invite Only
});

export const joinOrgSchema = z.object({
  message: z.string().optional(),
});

export const redeemInviteSchema = z.object({});

export type CreateOrgInput = z.infer<typeof createOrgSchema>;

// ── Free-text length limits ────────────────────────────────────────────────
// Mirrors the varchar column limits (Postgres counts characters, so compare
// code points). Checking at the endpoint turns an over-long value into a
// clear 400 instead of "value too long for type character varying" (a 500).
export const TEXT_LIMITS = {
  memberAlias: 32,      // org_members.alias_callsign
  memberTag: 16,        // org_members.org_tag_override
  orgCallsign: 64,      // organizations.callsign (create also requires >= 3)
  channelName: 64,      // user-made channels (column is 96; generated event names use the rest)
  roleName: 32,         // org_roles.name
  pushDeviceLabel: 64,  // admin_push_tokens.device_label
  pushToken: 255,       // admin_push_tokens.fcm_token
  // Server welcome panel (organizations.welcome_*, 000073; utils/orgWelcome.ts).
  // TEXT / JSONB columns, so these are app limits, mirrored by the strip's
  // editor (web-portal/src/components/strip/welcome/welcomeModel.js).
  welcomeSubtitle: 200,
  welcomeSectionTitle: 80,
  welcomeSectionBody: 4000, // markdown source
} as const;

/** organizations.welcome_sections holds at most this many sections. */
export const WELCOME_MAX_SECTIONS = 10;

/** Code-point length of a string value; 0 for anything else. */
export const textLength = (v: unknown): number => (typeof v === 'string' ? Array.from(v).length : 0);

/** A user-facing message when `v` is longer than `max`, else null. */
export function tooLong(label: string, v: unknown, max: number): string | null {
  return textLength(v) > max ? `${label} can be at most ${max} characters` : null;
}
