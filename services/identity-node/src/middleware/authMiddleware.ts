import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../config/jwtSecret.js';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    callsign: string;
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
      // 401, not 403 — this must match what the client's auth-expired
      // detection listens for (packages/shared-web/src/api.js), otherwise an
      // expired token silently fails every API call forever instead of
      // triggering re-auth.
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
      // 401, not 403 — this must match what the client's auth-expired
      // detection listens for (packages/shared-web/src/api.js), otherwise an
      // expired token silently fails every API call forever instead of
      // triggering re-auth.
      return res.status(401).json({ message: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};
