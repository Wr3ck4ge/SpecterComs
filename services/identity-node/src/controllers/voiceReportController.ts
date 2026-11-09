import { Response } from 'express';
import { z } from 'zod';
import { pool } from '../config/db.js';
import { AuthRequest } from '../middleware/authMiddleware.js';
import { encryptReportBuffer, decryptReportBuffer } from '../utils/reportEncryption.js';

// A clip is meant to be a short window around a specific incident, not the
// full client-side rolling buffer (~15 min) — capped well below that so one
// report can't balloon into an enormous blob. ~2.2MB raw is a few minutes of
// Opus at typical voice bitrates; base64 inflates that by ~4/3.
const MAX_AUDIO_CLIP_B64_LEN = 3_000_000;

const speakingHistoryEntrySchema = z.object({
  callsign: z.string().max(64),
  ts: z.number(),
  level: z.number(),
});

const submitVoiceReportSchema = z.object({
  accused_id: z.string().uuid(),
  org_id: z.string().uuid().nullable().optional(),
  channel_id: z.string().uuid().nullable().optional(),
  reported_at: z.string().datetime(),
  reporter_note: z.string().max(2000).nullable().optional(),
  audio_clip: z.string().max(MAX_AUDIO_CLIP_B64_LEN), // base64, see framing note in the migration
  speaking_history: z.array(speakingHistoryEntrySchema).max(2000),
  // ssrc (as a string key) -> user_id, from the reporter's own session — see
  // migration 000060. Optional/defaults empty: older clients, or a clip from
  // a still mixed-mode channel where every frame is ssrc=0, have nothing
  // meaningful to attribute.
  speaker_map: z.record(z.string(), z.string().uuid()).optional(),
});

// ── In-process rate limit: 5 reports per user per hour — same policy as
// abuseController.ts's text-report limit, for the same reason (real abuse
// prevention without making genuine reporters second-guess using it).
const reportCounts = new Map<string, { count: number; resetAt: number }>();

const checkRateLimit = (userId: string): boolean => {
  const now = Date.now();
  const entry = reportCounts.get(userId);
  if (!entry || now > entry.resetAt) {
    reportCounts.set(userId, { count: 1, resetAt: now + 3600_000 });
    return true;
  }
  if (entry.count >= 5) return false;
  entry.count += 1;
  return true;
};

/**
 * POST /voice-reports
 * Submits a short clip of recently-heard call audio (see web-portal's
 * MisconductReportBuffer, src-tauri/src/lib.rs) alongside who the app's
 * existing speaking-indicator flagged as active during that window, plus
 * speaker_map to attribute individual frames within the clip to a real
 * sender. In a relay-mode channel (see media-rust's RoomState::voice_relay_mode)
 * each frame carries its real per-sender ssrc, so segments are genuinely
 * attributable; in a still mixed-mode channel every frame is ssrc=0 (one
 * blended stream, no per-speaker isolation possible) and speaking_history
 * remains the best available signal for who was actually talking.
 */
export const submitVoiceReport = async (req: AuthRequest, res: Response) => {
  const reporterId = req.user?.id;
  if (!reporterId) return res.status(401).json({ message: 'Unauthorized' });

  if (!checkRateLimit(reporterId)) {
    return res.status(429).json({ message: 'Too many reports. Try again later.' });
  }

  const parsed = submitVoiceReportSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      message: 'Validation failed',
      errors: parsed.error.errors.map(e => ({ field: e.path.join('.'), message: e.message })),
    });
  }

  const { accused_id, org_id, channel_id, reported_at, reporter_note, audio_clip, speaking_history, speaker_map } = parsed.data;

  if (reporterId === accused_id) {
    return res.status(400).json({ message: 'Cannot report yourself' });
  }

  try {
    const accusedCheck = await pool.query('SELECT 1 FROM users WHERE id = $1', [accused_id]);
    if (accusedCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Accused user not found' });
    }

    let rawClip: Buffer;
    try {
      rawClip = Buffer.from(audio_clip, 'base64');
    } catch {
      return res.status(400).json({ message: 'audio_clip is not valid base64' });
    }
    const encryptedClip = encryptReportBuffer(rawClip);

    const result = await pool.query(
      `INSERT INTO voice_misconduct_reports
         (reporter_id, accused_id, org_id, channel_id, reported_at, reporter_note, audio_clip, speaking_history, speaker_map)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        reporterId,
        accused_id,
        org_id ?? null,
        channel_id ?? null,
        reported_at,
        reporter_note ?? null,
        encryptedClip,
        JSON.stringify(speaking_history),
        JSON.stringify(speaker_map ?? {}),
      ],
    );

    res.status(201).json({ id: result.rows[0].id });
  } catch (err) {
    console.error('submitVoiceReport error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * GET /admin/voice-reports?status=pending
 * List metadata only — never the audio itself, which stays encrypted at
 * rest until an admin explicitly opens one report (getVoiceReportAudio).
 */
export const listVoiceReports = async (req: AuthRequest, res: Response) => {
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const validStatuses = ['pending', 'reviewed', 'dismissed', 'actioned'];

  try {
    const rows = status && validStatuses.includes(status)
      ? (await pool.query(
          `SELECT vr.id, vr.reporter_id, ru.callsign AS reporter_callsign,
                  vr.accused_id, au.callsign AS accused_callsign,
                  vr.org_id, vr.channel_id, vr.reported_at, vr.reporter_note,
                  vr.speaking_history, vr.speaker_map, vr.status, vr.admin_notes, vr.created_at
           FROM voice_misconduct_reports vr
           LEFT JOIN users ru ON ru.id = vr.reporter_id
           LEFT JOIN users au ON au.id = vr.accused_id
           WHERE vr.status = $1
           ORDER BY vr.created_at DESC
           LIMIT 200`,
          [status],
        )).rows
      : (await pool.query(
          `SELECT vr.id, vr.reporter_id, ru.callsign AS reporter_callsign,
                  vr.accused_id, au.callsign AS accused_callsign,
                  vr.org_id, vr.channel_id, vr.reported_at, vr.reporter_note,
                  vr.speaking_history, vr.speaker_map, vr.status, vr.admin_notes, vr.created_at
           FROM voice_misconduct_reports vr
           LEFT JOIN users ru ON ru.id = vr.reporter_id
           LEFT JOIN users au ON au.id = vr.accused_id
           ORDER BY vr.created_at DESC
           LIMIT 200`,
        )).rows;

    res.json({ reports: rows });
  } catch (err) {
    console.error('listVoiceReports error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

/**
 * GET /admin/voice-reports/:id/audio
 * Decrypts and returns the raw audio clip bytes for exactly one report, only
 * when an admin explicitly requests it — not part of the list response.
 */
export const getVoiceReportAudio = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  try {
    const result = await pool.query(`SELECT audio_clip FROM voice_misconduct_reports WHERE id = $1`, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Report not found' });
    }
    const decrypted = decryptReportBuffer(result.rows[0].audio_clip as Buffer);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(decrypted);
  } catch (err) {
    console.error('getVoiceReportAudio error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};

const updateVoiceReportSchema = z.object({
  status: z.enum(['pending', 'reviewed', 'dismissed', 'actioned']),
  admin_notes: z.string().max(4000).nullable().optional(),
});

/** PATCH /admin/voice-reports/:id */
export const updateVoiceReportStatus = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const parsed = updateVoiceReportSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      message: 'Validation failed',
      errors: parsed.error.errors.map(e => ({ field: e.path.join('.'), message: e.message })),
    });
  }
  try {
    const result = await pool.query(
      `UPDATE voice_misconduct_reports SET status = $2, admin_notes = $3 WHERE id = $1 RETURNING id`,
      [id, parsed.data.status, parsed.data.admin_notes ?? null],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Report not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('updateVoiceReportStatus error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
};
