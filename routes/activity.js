import { Router } from 'express';
import { Activity } from '../models/Activity.js';
import { Group } from '../models/Group.js';
import { Member } from '../models/Member.js';
import { authMiddleware } from '../middleware/auth.js';
import { checkGroupMembership, requireGroupMember } from '../middleware/groupAccess.js';

export const activityRouter = Router();

activityRouter.use(authMiddleware);

// Rows only the group owner should see (money that needs manual reconciliation).
const OWNER_ONLY_TYPES = ['unallocated_funds'];

// Types a client may create. Financial rows (contribution, cashout, refund, ...)
// are written by the server only, because receipts are built from them.
const CLIENT_TYPES = ['member', 'note'];

const cap = v => Math.min(Math.max(Number(v) || 50, 1), 100);
const str = v => (typeof v === 'string' ? v : '');

function serverError(res, err) {
  console.error('[activity]', err);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// GET /?group_id=... -> must be an accepted member/owner of that group.
// GET / (no group_id) -> only activity across groups the caller belongs to.
activityRouter.get('/', async (req, res) => {
  try {
    const group_id = str(req.query.group_id);
    const limit = cap(req.query.limit);

    if (req.query.group_id !== undefined) {
      const access = await checkGroupMembership(group_id, req.userId);
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      const filter = { group_id };
      if (access.role !== 'owner') filter.type = { $nin: OWNER_ONLY_TYPES };
      const activity = await Activity.find(filter).sort({ created_at: -1 }).limit(limit);
      return res.json({ activity });
    }

    const owned = await Group.find({ owner_id: req.userId }).select('_id');
    const joined = await Member.find({ user_id: req.userId, status: 'active' }).select('group_id');
    const groupIds = [...owned.map(g => g._id), ...joined.map(m => m.group_id)];
    const activity = await Activity.find({ group_id: { $in: groupIds }, type: { $nin: OWNER_ONLY_TYPES } })
      .sort({ created_at: -1 }).limit(limit);
    res.json({ activity });
  } catch (err) {
    serverError(res, err);
  }
});

activityRouter.get('/group/:groupId', requireGroupMember(req => req.params.groupId), async (req, res) => {
  try {
    const filter = { group_id: req.params.groupId };
    if (req.groupRole !== 'owner') filter.type = { $nin: OWNER_ONLY_TYPES };
    const activity = await Activity.find(filter).sort({ created_at: -1 }).limit(cap(req.query.limit));
    res.json({ activity });
  } catch (err) {
    serverError(res, err);
  }
});

activityRouter.post('/', requireGroupMember(req => req.body?.group_id), async (req, res) => {
  try {
    const type = str(req.body?.type);
    const title = str(req.body?.title).trim();
    if (!type || !title) {
      return res.status(400).json({ error: 'group_id, type, and title are required' });
    }
    if (!CLIENT_TYPES.includes(type)) {
      return res.status(403).json({ error: 'This activity type is recorded automatically.' });
    }
    if (title.length > 200) return res.status(400).json({ error: 'Title is too long' });

    // The row is always attributed to the caller's own membership.
    const me = await Member.findOne({ group_id: req.group._id, user_id: req.userId, status: 'active' }).select('_id');

    const activity = await Activity.create({
      group_id: req.group._id,
      member_id: me?._id || null,
      type,
      title,
      status: 'completed',
      meta: str(req.body?.meta).slice(0, 300) || null,
    });
    res.status(201).json({ activity });
  } catch (err) {
    serverError(res, err);
  }
});