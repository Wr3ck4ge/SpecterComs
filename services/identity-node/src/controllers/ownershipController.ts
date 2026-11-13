import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware.js';
import {
  OwnershipError, initiateTransfer, cancelTransfer, acceptTransfer, declineTransfer,
  startClaim, ownershipStatus, incomingTransfers,
} from '../utils/ownershipTransfer.js';

const wrap = (fn: (req: AuthRequest, res: Response) => Promise<unknown>) => async (req: AuthRequest, res: Response) => {
  if (!req.user?.id) return res.status(401).json({ message: 'User not authenticated' });
  try {
    await fn(req, res);
  } catch (e) {
    if (e instanceof OwnershipError) return res.status(e.status).json({ message: e.message, code: e.code });
    console.error('[ownership]', e);
    res.status(500).json({ message: 'Internal server error' });
  }
};

const orgOf = (req: AuthRequest) => String(req.params.id);
const me = (req: AuthRequest) => req.user!.id as string;

export const getOwnership = wrap(async (req, res) => { res.json(await ownershipStatus(orgOf(req), me(req))); });
export const getIncoming = wrap(async (req, res) => { res.json({ transfers: await incomingTransfers(me(req)) }); });
export const postTransfer = wrap(async (req, res) => {
  const { to_user_id, password, second_factor } = req.body ?? {};
  res.status(201).json(await initiateTransfer(orgOf(req), me(req), to_user_id, password, second_factor));
});
export const deleteTransfer = wrap(async (req, res) => { await cancelTransfer(orgOf(req), me(req)); res.json({ ok: true }); });
export const postAccept = wrap(async (req, res) => {
  const { password, second_factor } = req.body ?? {};
  await acceptTransfer(orgOf(req), me(req), password, second_factor);
  res.json({ ok: true });
});
export const postDecline = wrap(async (req, res) => { await declineTransfer(orgOf(req), me(req)); res.json({ ok: true }); });
export const postClaim = wrap(async (req, res) => {
  const { password, second_factor } = req.body ?? {};
  res.status(201).json(await startClaim(orgOf(req), me(req), password, second_factor));
});
