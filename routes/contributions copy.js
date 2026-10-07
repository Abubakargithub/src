import { Router } from 'express';
import { Contribution } from '../models/Contribution.js';
import { Member } from '../models/Member.js';
import { Activity } from '../models/Activity.js';
import { authMiddleware } from '../middleware/auth.js';

export const contributionsRouter = Router();

contributionsRouter.use(authMiddleware);

contributionsRouter.get('/', async (req, res) => {
  try {
    const { group_id } = req.query;
    const filter = group_id ? { group_id } : {};
    const contributions = await Contribution.find(filter).sort({ created_at: -1 });
    res.json({ contributions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

contributionsRouter.get('/group/:groupId', async (req, res) => {
  try {
    const contributions = await Contribution.find({ group_id: req.params.groupId }).sort({ series_number: 1 });
    res.json({ contributions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

contributionsRouter.post('/', async (req, res) => {
  try {
    const { group_id, member_id, member_name, series_number, amount, payment_method, reference } = req.body;
    if (!group_id || !member_id || !amount) {
      return res.status(400).json({ error: 'group_id, member_id, and amount are required' });
    }
    const contribution = await Contribution.create({
      group_id, member_id, member_name: member_name || 'Unknown',
      series_number: series_number || 1, amount,
      status: 'completed', payment_method: payment_method || 'card',
      due_date: new Date().toISOString().slice(0, 10),
      paid_at: new Date(), reference: reference || null,
    });

    await Member.findByIdAndUpdate(member_id, { $inc: { paid_count: 1 }, status: 'active' });

    await Activity.create({
      group_id, member_id,
      type: 'contribution',
      title: `${member_name || 'Member'} contributed ₦${amount.toLocaleString()}`,
      amount, status: 'completed',
      payment_method: payment_method || 'card',
      reference: reference || null,
      meta: `Series ${series_number || 1}  ·  ${(payment_method || 'card').toUpperCase()}`,
    });

    res.status(201).json({ contribution });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
