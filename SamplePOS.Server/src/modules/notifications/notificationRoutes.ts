import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requirePermission } from '../../rbac/middleware.js';
import * as controller from './notificationController.js';

const router = Router();

router.use(authenticate);

router.get('/catalog', controller.getCatalog);
router.get('/preferences', controller.getPreferences);
router.put('/preferences', controller.putPreferences);
router.get('/', controller.getInbox);
router.get('/unread-count', controller.unreadCount);
router.post('/read-all', controller.markAllRead);
router.post('/test', controller.sendTest);
router.get('/devices', controller.listDevices);
router.post('/devices', controller.subscribeDevice);
router.patch('/devices/:id', controller.patchDevice);
router.delete('/devices/:id', controller.unsubscribeDevice);
router.get('/admin/policy', requirePermission('settings.update'), controller.getAdminPolicy);
router.put('/admin/policy', requirePermission('settings.update'), controller.putAdminPolicy);
router.get('/:id', controller.getOne);
router.post('/:id/read', controller.markRead);

export default router;
