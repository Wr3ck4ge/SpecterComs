import { Router } from 'express';
import { downloadClient } from '../controllers/downloadController.js';

const router = Router();

// GET /downloads?platform=windows|macos|linux
router.get('/', downloadClient);

export default router;
