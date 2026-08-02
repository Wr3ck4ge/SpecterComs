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

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

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
