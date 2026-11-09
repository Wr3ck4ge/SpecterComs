import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../config/jwtSecret.js';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    callsign?: string;
    purpose?: string;
  };
}

export const authenticateToken = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  // query.token fallback is intentional for SSE (EventSource cannot send custom headers).
  const token = (authHeader && authHeader.split(' ')[1])
    || (typeof req.query.token === 'string' ? req.query.token : undefined);

  if (!token) {
    return res.status(401).json({ message: 'Authentication token required' });
  }

  jwt.verify(token, getJwtSecret(), (err: any, user: any) => {
    if (err) {
      // Keep 401 (not 403) so the client triggers auth-expired handling.
      return res.status(401).json({ message: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// Strict variant: header-only token acceptance. Use on all non-SSE routes to prevent
// tokens from appearing in URLs (logs, browser history, proxy caches).
export const authenticateTokenStrict = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Authentication token required' });
  }

  jwt.verify(token, getJwtSecret(), (err: any, user: any) => {
    if (err) {
      // Keep 401 (not 403) so the client triggers auth-expired handling.
      return res.status(401).json({ message: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// SSE variant: query token only, scoped to short-lived SSE tickets.
export const authenticateSseToken = (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = typeof req.query.token === 'string' ? req.query.token : undefined;

  if (!token) {
    return res.status(401).json({ message: 'SSE ticket required' });
  }

  jwt.verify(token, getJwtSecret(), (err: any, user: any) => {
    if (err) {
      return res.status(401).json({ message: 'Invalid or expired SSE ticket' });
    }

    if (!user || user.purpose !== 'sse' || !user.id) {
      return res.status(401).json({ message: 'Invalid SSE ticket scope' });
    }

    req.user = { id: user.id, callsign: user.callsign, purpose: user.purpose };
    next();
  });
};
