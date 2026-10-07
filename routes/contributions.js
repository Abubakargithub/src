import { Router } from 'express';
import mongoose from 'mongoose';
import { Contribution } from '../models/Contribution.js';
import { Member } from '../models/Member.js';
import { Group } from '../models/Group.js';
import { authMiddleware } from '../middleware/auth.js';
import { checkGroupMembership, requireGroupMember } from '../middleware/groupAccess.js';

export const contributionsRouter = Router();

contributionsRouter.use(authMiddleware);

// GET /?group_id=... -> must be an accepted member/owner of that group.
// GET / (no group_id) -> only contributions across groups the caller belongs to.
contributionsRouter.get('/', async (req, res) => {
  try {
    const { group_id } = req.query;

    if (group_id) {
      if (!mongoose.isValidObjectId(group_id)) return res.status(400).json({ error: 'Invalid group_id' });
      const access = await checkGroupMembership(group_id, req.userId);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      const contributions = await Contribution.find({ group_id }).sort({ created_at: -1 });
      return res.json({ contributions });
    }

    const owned = await Group.find({ owner_id: req.userId }).select('_id');
    const joined = await Member.find({ user_id: req.userId, status: 'active' }).select('group_id');
    const groupIds = [...owned.map(g => g._id), ...joined.map(m => m.group_id)];
    const contributions = await Contribution.find({ group_id: { $in: groupIds } }).sort({ created_at: -1 });
    res.json({ contributions });
  } catch (err) {
    console.error('[contributions] list failed:', err.message);
    res.status(500).json({ error: 'Could not load contributions' });
  }
});

contributionsRouter.get('/group/:groupId', requireGroupMember(req => req.params.groupId), async (req, res) => {
  try {
    const contributions = await Contribution.find({ group_id: req.params.groupId }).sort({ series_number: 1 });
    res.json({ contributions });
  } catch (err) {
    console.error('[contributions] group list failed:', err.message);
    res.status(500).json({ error: 'Could not load contributions' });
  }
});

// Contributions can no longer be created by clients.
//
// A contribution is recorded ONLY when Paystack confirms that money reached the
// member's virtual account (see the webhook in routes/paystack.js). Letting a
// client (or the group owner) mark a series as "paid" would let someone trigger
// a cash-out for money that was never received.
contributionsRouter.post('/', (_req, res) => {
  res.status(410).json({ error: 'Contributions are recorded automatically once your transfer is received.' });
});