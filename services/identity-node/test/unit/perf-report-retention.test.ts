import { describe, it, expect } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { pruneOldReports } from '../../src/routes/diag.js';

describe('perf report retention', () => {
    it('deletes perf reports older than the TTL and keeps newer ones and unrelated files', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perf-ttl-'));
        const day = 24 * 60 * 60 * 1000;
        const now = Date.now();
        const old = path.join(dir, 'perf-1-old.json');
        const fresh = path.join(dir, 'perf-2-new.json');
        const other = path.join(dir, 'notes.txt');
        for (const f of [old, fresh, other]) await fs.writeFile(f, '{}');
        await fs.utimes(old, new Date(now - 8 * day), new Date(now - 8 * day));
        await fs.utimes(other, new Date(now - 30 * day), new Date(now - 30 * day));

        const removed = await pruneOldReports(dir, 7 * day, now);

        expect(removed).toBe(1);
        const left = (await fs.readdir(dir)).sort();
        expect(left).toEqual(['notes.txt', 'perf-2-new.json']);
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('returns 0 when the directory does not exist', async () => {
        expect(await pruneOldReports(path.join(os.tmpdir(), 'perf-ttl-missing-xyz'), 1000)).toBe(0);
    });
});
