import { Router } from 'express';
import { createOrg, getMyOrgs, joinOrg, getOrgToken, issueOrgMediaTicket, redeemInvite, getPublicServers, updateOrgSettings, updateMemberProfile, createInvite, listInvites, revokeInvite, updateOrgLanding, uploadOrgLogo, orgLogoUpload } from '../controllers/orgController.js';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import { validate } from '../middleware/validationMiddleware.js';
import { createOrgSchema, joinOrgSchema } from '../utils/validation.js';
import { getOrgBans, unbanMember } from '../controllers/modController.js';
import channelRoutes from './channel.js';
import { attestAdult } from '../controllers/channelController.js';
import roleRoutes from './role.js';
import modRoutes from './mod.js';
import eventRoutes from './events.js';
import billingRoutes from './billing.js';
import messageRoutes, { orgMessageRoutes } from './message.js';
import mlsGroupRoutes from './mlsGroup.js';
import { getOwnership, getIncoming, postTransfer, deleteTransfer, postAccept, postDecline, postClaim } from '../controllers/ownershipController.js';
import { requireOwnerTwoFactor } from '../controllers/twoFactorController.js'; // L3
import { getOrgWelcome, updateOrgWelcome } from '../controllers/orgWelcomeController.js';

const router = Router();

router.get('/public', getPublicServers);

// Protect all routes
router.use(authenticateTokenStrict);

router.post('/:orgId/adult-attestation', authenticateTokenStrict, attestAdult as any); // L11
router.use('/:orgId/channels', channelRoutes);
router.use('/:orgId/roles', roleRoutes);
router.use('/:orgId/members', modRoutes);
router.use('/:orgId/events', eventRoutes);
router.use('/:id/billing', billingRoutes);
router.use('/:orgId/channels/:chanId/messages', messageRoutes);
router.use('/:orgId/messages', orgMessageRoutes); // MR2: org-wide catch-up
router.use('/:orgId/channels/:chanId/mls', mlsGroupRoutes);

router.get('/ownership/incoming',       getIncoming);
router.get('/:id/ownership',            getOwnership);
router.post('/:id/ownership/transfer',  postTransfer);
router.delete('/:id/ownership/transfer', deleteTransfer);
router.post('/:id/ownership/accept',    postAccept);
router.post('/:id/ownership/decline',   postDecline);
router.post('/:id/ownership/claim',     postClaim);
router.post('/',                        validate(createOrgSchema), createOrg);
router.get('/me',                       getMyOrgs);
router.post('/invite/:code/redeem',     redeemInvite);
router.post('/:id/join',                validate(joinOrgSchema), joinOrg);
router.post('/:id/token',               getOrgToken);
router.post('/:id/media-ticket',        issueOrgMediaTicket);
router.put('/:id/settings',             requireOwnerTwoFactor, updateOrgSettings);
router.put('/:id/profile',              updateMemberProfile);
router.post('/:id/invites',             createInvite);
router.get('/:id/invites',              listInvites);
router.delete('/:id/invites/:code',     revokeInvite);
router.put('/:id/landing',              updateOrgLanding);
router.get('/:id/welcome',              getOrgWelcome);    // members; the strip's welcome pane
router.put('/:id/welcome',              updateOrgWelcome); // owner / Commander / can_manage_channels
router.post('/:id/logo',                orgLogoUpload.single('image'), uploadOrgLogo as any);

// Bans
router.get('/:orgId/bans',              getOrgBans as any);
router.post('/:orgId/members/:userId/unban', unbanMember as any);

export default router;
