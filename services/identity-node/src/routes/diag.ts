import { Router } from 'express';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import fs from 'fs/promises';
import path from 'path';

const router = Router();

// Hard cap: reject payloads over 2 MB to prevent disk exhaustion.
// The typical perf report (2 000 frames × ~6 fields) serialises to < 200 KB.
const MAX_REPORT_BYTES = 2 * 1024 * 1024;

// Privacy: reports hold user diagnostics, so they are kept only long enough to
// be read. Anything older than PERF_REPORT_TTL_DAYS (default 7) is deleted on
// every write and by an hourly sweep.
const REPORTS_DIR = () => process.env.PERF_REPORTS_DIR || '/tmp/specter-perf-reports';
const REPORT_TTL_MS = () => Math.max(1, Number(process.env.PERF_REPORT_TTL_DAYS) || 7) * 24 * 60 * 60 * 1000;

export async function pruneOldReports(dir = REPORTS_DIR(), ttlMs = REPORT_TTL_MS(), now = Date.now()): Promise<number> {
    let removed = 0;
    let names: string[];
    try { names = await fs.readdir(dir); } catch { return 0; }
    for (const name of names) {
        if (!/^perf-.*\.json$/.test(name)) continue;
        const file = path.join(dir, name);
        try {
            const st = await fs.stat(file);
            if (now - st.mtimeMs > ttlMs) { await fs.unlink(file); removed++; }
        } catch { /* raced with another sweep */ }
    }
    return removed;
}

const sweep = setInterval(() => { pruneOldReports().catch(() => {}); }, 60 * 60 * 1000);
sweep.unref?.();

/**
 * POST /diag/perf-report
 *
 * Accepts a JSON performance report from the Tauri client and saves it to disk.
 * Gated by the PERF_REPORT_ENABLED=true env var so it is never active in
 * production unless explicitly opted in.
 */
router.post('/perf-report', authenticateTokenStrict as any, async (req: any, res) => {
    if (process.env.PERF_REPORT_ENABLED !== 'true') {
        return res.status(404).json({ message: 'Not found' });
    }

    const raw = JSON.stringify(req.body);
    if (Buffer.byteLength(raw, 'utf8') > MAX_REPORT_BYTES) {
        return res.status(413).json({ message: 'Report payload too large' });
    }

    const report = {
        userId:      req.user?.id,
        callsign:    req.user?.callsign,
        submittedAt: new Date().toISOString(),
        data:        req.body,
    };

    const dir = REPORTS_DIR();
    await pruneOldReports(dir).catch(() => 0);

    // Sanitize user ID so it cannot inject path separators or special chars.
    const safeId = String(req.user?.id ?? 'unknown').replace(/[^a-z0-9_-]/gi, '_');
    const filename = `perf-${Date.now()}-${safeId}.json`;

    try {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, filename), JSON.stringify(report, null, 2));
    } catch (err) {
        console.error('[diag] failed to write perf report:', err);
        return res.status(500).json({ message: 'Failed to save report' });
    }

    console.log('[diag] perf report received ->', filename);
    res.json({ ok: true, filename });
});

export default router;
