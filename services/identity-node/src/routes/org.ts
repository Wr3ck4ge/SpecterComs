import { Router } from 'express';
import { createOrg, getMyOrgs, joinOrg, getOrgToken, redeemInvite, getPublicServers, updateOrgSettings, updateMemberProfile, createInvite, updateOrgLanding, uploadOrgLogo, orgLogoUpload } from '../controllers/orgController.js';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import { validate } from '../middleware/validationMiddleware.js';
import { createOrgSchema, joinOrgSchema } from '../utils/validation.js';
import { getOrgBans, unbanMember } from '../controllers/modController.js';
import channelRoutes from './channel.js';
import roleRoutes from './role.js';
import modRoutes from './mod.js';
import eventRoutes from './events.js';
import billingRoutes from './billing.js';
import messageRoutes from './message.js';
import mlsGroupRoutes from './mlsGroup.js';

const router = Router();

router.get('/public', getPublicServers);

// Protect all routes
router.use(authenticateTokenStrict);

router.use('/:orgId/channels', channelRoutes);
router.use('/:orgId/roles', roleRoutes);
router.use('/:orgId/members', modRoutes);
router.use('/:orgId/events', eventRoutes);
router.use('/:id/billing', billingRoutes);
router.use('/:orgId/channels/:chanId/messages', messageRoutes);
router.use('/:orgId/channels/:chanId/mls', mlsGroupRoutes);

router.post('/',                        validate(createOrgSchema), createOrg);
router.get('/me',                       getMyOrgs);
router.post('/invite/:code/redeem',     redeemInvite);
router.post('/:id/join',                validate(joinOrgSchema), joinOrg);
router.post('/:id/token',               getOrgToken);
router.put('/:id/settings',             updateOrgSettings);
router.put('/:id/profile',              updateMemberProfile);
router.post('/:id/invites',             createInvite);
router.put('/:id/landing',              updateOrgLanding);
router.post('/:id/logo',                orgLogoUpload.single('image'), uploadOrgLogo as any);

// Bans
router.get('/:orgId/bans',              getOrgBans as any);
router.post('/:orgId/members/:userId/unban', unbanMember as any);

export default router;
