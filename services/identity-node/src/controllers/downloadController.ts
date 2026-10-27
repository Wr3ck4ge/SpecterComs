import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

const UPDATES_DIR = process.env.UPDATES_DIR || '/updates';
const LATEST_VERSION_FILE = process.env.LATEST_VERSION_FILE || '/updates/LATEST_VERSION';

// Maps platform query param to installer filename suffixes in priority order
const PLATFORM_SUFFIXES: Record<string, string[]> = {
  windows: ['_x64-setup.exe', '_x64_en-US.msi'],
  macos:   ['.dmg'],
  linux:   ['.AppImage', '.deb'],
};

export const downloadClient = (req: Request, res: Response) => {
  const platform = (req.query.platform as string || '').toLowerCase();

  const suffixes = PLATFORM_SUFFIXES[platform];
  if (!suffixes) {
    return res.status(400).json({ message: 'Invalid platform. Use: windows, macos, or linux' });
  }

  // Determine the current version from LATEST_VERSION file
  let version: string;
  try {
    version = fs.readFileSync(LATEST_VERSION_FILE, 'utf8').trim();
  } catch {
    return res.status(503).json({ message: 'Download service not available' });
  }

  // Find the first matching file for this platform + version
  let filename: string | undefined;
  for (const suffix of suffixes) {
    const candidate = `SpecterComs_${version}${suffix}`;
    if (fs.existsSync(path.join(UPDATES_DIR, candidate))) {
      filename = candidate;
      break;
    }
  }

  if (!filename) {
    return res.status(404).json({ message: `No installer found for platform: ${platform}` });
  }

  const filePath = path.join(UPDATES_DIR, filename);
  const stat = fs.statSync(filePath);

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', stat.size);

  fs.createReadStream(filePath).pipe(res);
};
