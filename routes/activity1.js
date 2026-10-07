import { Router } from 'express';
import { Activity } from '../models/Activity.js';
import { authMiddleware } from '../middleware/auth.js';

export const activityRouter = Router();

activityRouter.use(authMiddleware);

activityRouter.get('/', async (req, res) => {
  try {
    const { group_id, limit } = req.query;
    const filter = group_id ? { group_id } : {};
    const activity = await Activity.find(filter).sort({ created_at: -1 }).limit(Number(limit) || 50);
    res.json({ activity });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

activityRouter.get('/group/:groupId', async (req, res) => {
  try {
    const activity = await Activity.find({ group_id: req.params.groupId }).sort({ created_at: -1 }).limit(Number(req.query.limit) || 50);
    res.json({ activity });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

activityRouter.post('/', async (req, res) => {
  try {
    const { group_id, member_id, type, title, amount, status, payment_method, reference, meta } = req.body;
    if (!group_id || !type || !title) {
      return res.status(400).json({ error: 'group_id, type, and title are required' });
    }
    const activity = await Activity.create({
      group_id, member_id: member_id || null, type, title,
      amount: amount || null, status: status || 'completed',
      payment_method: payment_method || null, reference: reference || null, meta: meta || null,
    });
    res.status(201).json({ activity });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
