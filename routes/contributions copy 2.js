import { Router } from 'express';
import { Contribution } from '../models/Contribution.js';
import { Member } from '../models/Member.js';
import { Activity } from '../models/Activity.js';
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
    res.status(500).json({ error: err.message });
  }
});

contributionsRouter.get('/group/:groupId', requireGroupMember(req => req.params.groupId), async (req, res) => {
  try {
    const contributions = await Contribution.find({ group_id: req.params.groupId }).sort({ series_number: 1 });
    res.json({ contributions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DVA is the only supported payment method now (bug #10) — card/USSD have
// been removed from the client, so we no longer accept or default to them
// here either. Any legacy 'card'/'ussd' rows already in the database are
// left as historical records; they just can't be created going forward.
contributionsRouter.post('/', requireGroupMember(req => req.body.group_id), async (req, res) => {
  try {
    const { group_id, member_id, member_name, series_number, amount, reference } = req.body;
    if (!group_id || !member_id || !amount) {
      return res.status(400).json({ error: 'group_id, member_id, and amount are required' });
    }
    const member = await Member.findOne({ _id: member_id, group_id, user_id: req.userId, status: 'active' });
    if (!member && req.groupRole !== 'owner') {
      return res.status(403).json({ error: 'You can only contribute for your own membership' });
    }
    const targetMember = member || await Member.findOne({ _id: member_id, group_id, status: { $nin: ['exited', 'exit_pending_replacement'] } });
    if (!targetMember) return res.status(404).json({ error: 'Member not found in this group' });
    const targetSeries = series_number || 1;
    const existing = await Contribution.findOne({ group_id, member_id, series_number: targetSeries, status: { $in: ['pending', 'completed'] } });
    if (existing) return res.status(409).json({ error: `Series ${targetSeries} has already been paid` });
    const schedule = await (await import('../models/Schedule.js')).Schedule.findOne({ group_id, series_number: targetSeries });
    const contribution = await Contribution.create({
      group_id, member_id, member_name: member_name || 'Unknown',
      series_number: targetSeries, amount,
      status: 'completed', payment_method: 'dva',
      due_date: schedule?.due_date || new Date().toISOString().slice(0, 10),
      paid_at: new Date(), reference: reference || null,
    });

    await Member.findByIdAndUpdate(targetMember._id, { $inc: { paid_count: 1 }, status: 'active' });
    const activeMemberCount = await Member.countDocuments({ group_id, status: { $in: ['active', 'pending'] } });
    const paidMemberCount = await Contribution.countDocuments({ group_id, series_number: targetSeries, status: 'completed' });
    if (schedule && paidMemberCount >= activeMemberCount) {
      schedule.status = 'completed';
      await schedule.save();
    }

    await Activity.create({
      group_id, member_id,
      type: 'contribution',
      title: `${member_name || 'Member'} contributed ₦${amount.toLocaleString()}`,
      amount, status: 'completed',
      payment_method: 'dva',
      reference: reference || null,
      meta: `Series ${targetSeries}  ·  DVA`,
    });

    res.status(201).json({ contribution });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});