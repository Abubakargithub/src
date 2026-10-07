import { Router } from 'express';
import { Notification } from '../models/Notification.js';
import { authMiddleware } from '../middleware/auth.js';
import { isObjectId } from '../middleware/groupAccess.js';

export const notificationsRouter = Router();

notificationsRouter.use(authMiddleware);

function serverError(res, err) {
  console.error('[notifications]', err);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// List the current user's notifications, most recent first.
notificationsRouter.get('/', async (req, res) => {
  try {
    const { limit, unread_only } = req.query;
    const filter = { user_id: req.userId };
    if (unread_only === 'true') filter.read = false;
    const cap = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const notifications = await Notification.find(filter).sort({ created_at: -1 }).limit(cap);
    res.json({ notifications });
  } catch (err) {
    serverError(res, err);
  }
});

// Small helper for a badge count without pulling the whole list.
notificationsRouter.get('/unread-count', async (req, res) => {
  try {
    const count = await Notification.countDocuments({ user_id: req.userId, read: false });
    res.json({ count });
  } catch (err) {
    serverError(res, err);
  }
});

notificationsRouter.put('/read-all', async (req, res) => {
  try {
    await Notification.updateMany({ user_id: req.userId, read: false }, { read: true });
    res.json({ success: true });
  } catch (err) {
    serverError(res, err);
  }
});

notificationsRouter.put('/:id/read', async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid notification ID' });
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, user_id: req.userId },
      { read: true },
      { new: true }
    );
    if (!notification) return res.status(404).json({ error: 'Notification not found' });
    res.json({ notification });
  } catch (err) {
    serverError(res, err);
  }
});