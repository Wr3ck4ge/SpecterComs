import { Router } from 'express';
import { authenticateTokenStrict } from '../middleware/authMiddleware.js';
import {
  getOrgEvents, getOrgEventHistory, createOrgEvent, rsvpEvent, updateOrgEvent, deleteOrgEvent,
  getEventGroups, saveEventGroups, launchEvent,
  getEventPlanners, setEventPlanners, joinEventGroup, leaveEventGroup, joinEventRole, leaveEventRole,
  approveGroupMember, removeGroupMember, approveAllGroupMembers,
  quickJoinEvent, leaveMyEventSignup,
  respondEventAssignment, getEventChannelTree, getEventPresets, saveEventPreset, deleteEventPreset,
  pingPresence, clearPresence, getMyEventAssignment, endOperation, getEventFrequencies,
  getGroupShipMatch, getEventMapLayout, saveEventMapLayout, uploadEventMapModel, mapModelUpload, getGroupDpsEstimate,
  getClaimableShips, claimShipSlot, releaseShipSlot
} from '../controllers/eventsController.js';

const router = Router({ mergeParams: true });

router.get('/',                              authenticateTokenStrict, getOrgEvents as any);
router.get('/history',                       authenticateTokenStrict, getOrgEventHistory as any);
router.post('/',                             authenticateTokenStrict, createOrgEvent as any);
router.put('/:eventId',                      authenticateTokenStrict, updateOrgEvent as any);
router.delete('/:eventId',                   authenticateTokenStrict, deleteOrgEvent as any);
router.post('/:eventId/rsvp',                authenticateTokenStrict, rsvpEvent as any);
router.get('/:eventId/groups',               authenticateTokenStrict, getEventGroups as any);
router.put('/:eventId/groups',               authenticateTokenStrict, saveEventGroups as any);
router.get('/:eventId/frequencies',          authenticateTokenStrict, getEventFrequencies as any);
router.get('/:eventId/map-layout',           authenticateTokenStrict, getEventMapLayout as any);
router.put('/:eventId/map-layout',           authenticateTokenStrict, saveEventMapLayout as any);
router.post('/:eventId/map-models',          authenticateTokenStrict, mapModelUpload.single('model'), uploadEventMapModel as any);
router.post('/:eventId/launch',              authenticateTokenStrict, launchEvent as any);
router.get('/:eventId/tree',                 authenticateTokenStrict, getEventChannelTree as any);
router.get('/:eventId/planners',             authenticateTokenStrict, getEventPlanners as any);
router.put('/:eventId/planners',             authenticateTokenStrict, setEventPlanners as any);
router.post('/:eventId/groups/:groupId/join', authenticateTokenStrict, joinEventGroup as any);
router.post('/:eventId/groups/:groupId/leave', authenticateTokenStrict, leaveEventGroup as any);
router.post('/:eventId/groups/:groupId/roles/:roleId/join', authenticateTokenStrict, joinEventRole as any);
router.delete('/:eventId/groups/:groupId/roles/:roleId/join', authenticateTokenStrict, leaveEventRole as any);
router.get('/:eventId/groups/:groupId/ship-match', authenticateTokenStrict, getGroupShipMatch as any);
router.get('/:eventId/groups/:groupId/dps-estimate', authenticateTokenStrict, getGroupDpsEstimate as any);
router.get('/:eventId/groups/:groupId/claimable-ships', authenticateTokenStrict, getClaimableShips as any);
router.post('/:eventId/groups/:groupId/ships/:shipSlug/claim', authenticateTokenStrict, claimShipSlot as any);
router.delete('/:eventId/groups/:groupId/ships/:shipSlug/claim', authenticateTokenStrict, releaseShipSlot as any);
router.post('/:eventId/groups/:groupId/members/:userId/approve', authenticateTokenStrict, approveGroupMember as any);
router.post('/:eventId/groups/:groupId/members/approve-all', authenticateTokenStrict, approveAllGroupMembers as any);
router.delete('/:eventId/groups/:groupId/members/:userId', authenticateTokenStrict, removeGroupMember as any);
router.post('/:eventId/join-quick', authenticateTokenStrict, quickJoinEvent as any);
router.delete('/:eventId/my-signup', authenticateTokenStrict, leaveMyEventSignup as any);
router.post('/:eventId/respond',             authenticateTokenStrict, respondEventAssignment as any);
router.post('/:eventId/presence',            authenticateTokenStrict, pingPresence as any);
router.delete('/:eventId/presence',          authenticateTokenStrict, clearPresence as any);
router.get('/:eventId/my-assignment',        authenticateTokenStrict, getMyEventAssignment as any);
router.post('/:eventId/end',                 authenticateTokenStrict, endOperation as any);

// Channel layout presets (org-scoped)
router.get('/presets',                       authenticateTokenStrict, getEventPresets as any);
router.post('/presets',                      authenticateTokenStrict, saveEventPreset as any);
router.delete('/presets/:presetId',          authenticateTokenStrict, deleteEventPreset as any);

export default router;
