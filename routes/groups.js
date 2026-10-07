import { Router } from 'express';
import { Group } from '../models/Group.js';
import { Member } from '../models/Member.js';
import { SeriesPosition } from '../models/SeriesPosition.js';
import { Schedule } from '../models/Schedule.js';
import { Activity } from '../models/Activity.js';
import { User } from '../models/User.js';
import { Notification } from '../models/Notification.js';
import { Contribution } from '../models/Contribution.js';
import { DVA } from '../models/DVA.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireGroupMember, requireGroupOwner, isObjectId } from '../middleware/groupAccess.js';
import { normalizePhone } from '../utils/phone.js';
import { lagosToday } from '../utils/date.js';
import { FEE_PAYER_OPTIONS, feePayer as normalizeFeePayer, feePercent } from '../lib/fees.js';

export const groupsRouter = Router();

groupsRouter.use(authMiddleware);

// Any :id / :memberId in a path must be a real ObjectId string.
groupsRouter.param('id', (req, res, next, id) =>
  isObjectId(id) ? next() : res.status(400).json({ error: 'Invalid group id' }));
groupsRouter.param('memberId', (req, res, next, id) =>
  isObjectId(id) ? next() : res.status(400).json({ error: 'Invalid member id' }));

function serverError(res, err) {
  console.error('[groups]', err);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

const initialsOf = name => String(name).split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();

// Every group leaves the API with a valid `fee_payer` ('Creator pays' | 'Shared')
// and a numeric `service_fee_percent`, even for older groups saved before those
// fields existed. Pass a plain object (doc.toObject() / doc.toJSON()).
const groupToClient = obj => ({
  ...obj,
  fee_payer: normalizeFeePayer(obj),
  service_fee_percent: feePercent(obj),
});

// Each group is tagged with is_owner so the frontend can split owned vs joined.
groupsRouter.get('/', async (req, res) => {
  try {
    const owned = await Group.find({ owner_id: req.userId }).sort({ created_at: 1 });
    const joinedMemberships = await Member.find({ user_id: req.userId, status: 'active' }).select('group_id');
    const joinedGroupIds = joinedMemberships.map(m => m.group_id);
    const joinedGroups = await Group.find({ _id: { $in: joinedGroupIds }, owner_id: { $ne: req.userId } }).sort({ created_at: 1 });

    const taggedOwned = owned.map(g => ({ ...groupToClient(g.toObject()), is_owner: true }));
    const taggedJoined = joinedGroups.map(g => ({ ...groupToClient(g.toObject()), is_owner: false }));

    res.json({ groups: [...taggedOwned, ...taggedJoined] });
  } catch (err) {
    serverError(res, err);
  }
});

// Pending invites addressed to the caller (matched by phone), across all
// groups. Registered before '/:id' so Express doesn't swallow this path.
groupsRouter.get('/invites', async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    const normalizedPhone = normalizePhone(user?.phone);
    if (!normalizedPhone) return res.json({ invites: [] });

    const pending = await Member.find({ phone: normalizedPhone, status: 'pending' }).sort({ created_at: -1 });
    const groupIds = pending.map(m => m.group_id);
    const groups = await Group.find({ _id: { $in: groupIds } });
    const groupById = Object.fromEntries(groups.map(g => [String(g._id), g]));

    const invites = pending
      .filter(m => groupById[String(m.group_id)])
      .map(m => ({ member: m, group: groupToClient(groupById[String(m.group_id)].toJSON()) }));

    res.json({ invites });
  } catch (err) {
    serverError(res, err);
  }
});

groupsRouter.get('/:id', requireGroupMember(req => req.params.id), async (req, res) => {
  try {
    res.json({ group: groupToClient(req.group.toJSON()) });
  } catch (err) {
    serverError(res, err);
  }
});

groupsRouter.post('/', async (req, res) => {
  try {
    const b = req.body || {};

    // ---- Input validation ----
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > 100) return res.status(400).json({ error: 'A group name (max 100 characters) is required' });

    const amount = Number(b.contribution_amount);
    if (!Number.isInteger(amount) || amount < 100 || amount > 10_000_000) {
      return res.status(400).json({ error: 'Contribution amount must be a whole number between ₦100 and ₦10,000,000' });
    }

    const frequency = typeof b.frequency === 'string' ? b.frequency.trim() : '';
    if (!frequency || frequency.length > 20) return res.status(400).json({ error: 'A valid frequency is required' });

    const memberCount = b.member_count === undefined || b.member_count === null ? 6 : Number(b.member_count);
    if (!Number.isInteger(memberCount) || memberCount < 2 || memberCount > 50) {
      return res.status(400).json({ error: 'Member count must be a whole number between 2 and 50' });
    }

    // start_date is required: without it no schedule exists and the group can never auto-pay out.
    const start_date = typeof b.start_date === 'string' ? b.start_date : '';
    if (!start_date || Number.isNaN(new Date(start_date).getTime())) {
      return res.status(400).json({ error: 'A valid start date is required' });
    }

    const description = typeof b.description === 'string' && b.description.trim() ? b.description.trim().slice(0, 500) : null;
    const category = typeof b.category === 'string' && b.category.trim() ? b.category.trim().slice(0, 50) : 'Family';
    const contribution_day = typeof b.contribution_day === 'string' ? b.contribution_day : 'Saturday';

    const invites = Array.isArray(b.invited_members)
      ? b.invited_members.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim().slice(0, 100))
      : [];
    if (invites.length > memberCount - 1) {
      return res.status(400).json({ error: `You can invite at most ${memberCount - 1} people (you are member 1)` });
    }

    // Only the two supported values are stored; anything else is treated as 'Shared'.
    const chosenFeePayer = normalizeFeePayer({ fee_payer: b.fee_payer });

    const group = await Group.create({
      name, description,
      category,
      contribution_amount: amount, frequency,
      member_count: memberCount,
      start_date,
      contribution_day,
      fee_payer: chosenFeePayer, service_fee_percent: 5,
      status: 'upcoming', current_series: 1,
      owner_id: req.userId,
    });

    // If the Group schema has no fee_payer / service_fee_percent fields, Mongoose
    // silently drops them and the UI will always show the defaults. Make that loud.
    if (group.get('fee_payer') !== chosenFeePayer || group.get('service_fee_percent') == null) {
      console.warn(`[groups] fee fields were NOT saved for group ${group._id} — add fee_payer and service_fee_percent to the Group schema`);
    }

    const user = await User.findById(req.userId);
    const creatorName = user?.full_name || 'You';

    const member = await Member.create({
      group_id: group._id,
      user_id: req.userId,
      name: creatorName,
      initials: initialsOf(creatorName),
      position: 1,
      role: 'creator',
      paid_count: 0,
      status: 'active',
    });

    await SeriesPosition.create({ group_id: group._id, member_id: member._id, position: 1, reason: 'Initial assignment' });

    await Activity.create({
      group_id: group._id,
      member_id: member._id,
      type: 'member',
      title: `${creatorName} created ${name}`,
      status: 'completed',
      meta: `${category}  ·  ₦${amount.toLocaleString()} ${frequency}  ·  ${memberCount} members`,
    });

    const rows = [];
    const start = new Date(start_date);
    const dayMap = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
    const targetDay = dayMap[contribution_day] ?? 0;
    const diff = (targetDay - start.getDay() + 7) % 7;
    start.setDate(start.getDate() + diff);
    const intervalDays = frequency === 'Daily' ? 1 : frequency === 'Weekly' ? 7 : 30;
    for (let i = 0; i < memberCount; i++) {
      const due = new Date(start);
      due.setDate(due.getDate() + i * intervalDays);
      rows.push({ group_id: group._id, series_number: i + 1, due_date: due.toISOString().slice(0, 10), status: 'pending' });
    }
    await Schedule.insertMany(rows);

    // Turn the invite list collected in the UI into actual pending members.
    // Every invite must be a phone number, since that is the only field the
    // /join flow can match a signing-up user against.
    for (let i = 0; i < invites.length; i++) {
      const raw = invites[i];

      const looksLikePhone = /^[+\d][\d\s-]{6,}$/.test(raw);
      const phone = looksLikePhone ? normalizePhone(raw) : null;
      const inviteName = raw;

      const invitedMember = await Member.create({
        group_id: group._id,
        phone,
        name: inviteName,
        initials: initialsOf(inviteName) || '??',
        position: i + 2, // position 1 is the creator
        role: 'member',
        paid_count: 0,
        status: 'pending',
        user_id: null,
      });

      await SeriesPosition.create({
        group_id: group._id,
        member_id: invitedMember._id,
        position: invitedMember.position,
        reason: 'Invited at group creation',
      });

      // If this phone number already belongs to a Dashe user, notify them
      // in-app right away. Otherwise GET /api/groups/invites picks it up after signup.
      if (phone) {
        const invitedUser = await User.findOne({ phone });
        if (invitedUser) {
          await Notification.create({
            user_id: invitedUser._id,
            group_id: group._id,
            member_id: invitedMember._id,
            type: 'invite',
            title: `${creatorName} invited you to join ${name}`,
            body: `₦${amount.toLocaleString()} ${frequency}  ·  ${memberCount} members`,
            meta: { group_id: String(group._id) },
          });
        }
      }
    }

    res.status(201).json({ group: groupToClient(group.toJSON()) });
  } catch (err) {
    serverError(res, err);
  }
});

// Owner changes who pays the service fee. Only allowed before any money has
// moved: once a contribution exists or a virtual account has been issued, the
// amounts members were told to pay depend on the current setting.
groupsRouter.put('/:id/fee-payer', requireGroupMember(req => req.params.id), requireGroupOwner, async (req, res) => {
  try {
    const next = String(req.body?.fee_payer ?? '');
    if (!FEE_PAYER_OPTIONS.includes(next)) {
      return res.status(400).json({ error: `fee_payer must be one of: ${FEE_PAYER_OPTIONS.join(', ')}` });
    }

    const [hasContribution, hasDva] = await Promise.all([
      Contribution.exists({ group_id: req.params.id }),
      DVA.exists({ group_id: req.params.id }),
    ]);
    if (hasContribution || hasDva) {
      return res.status(409).json({ error: 'The fee payer can no longer be changed because payments have already started for this group.' });
    }

    req.group.fee_payer = next;
    if (req.group.service_fee_percent == null) req.group.service_fee_percent = 5;
    await req.group.save();

    res.json({ group: groupToClient(req.group.toJSON()) });
  } catch (err) {
    serverError(res, err);
  }
});

// Guarantor details are private to the group owner and the member themselves.
// Phone numbers are visible to the owner and the member themselves only.
groupsRouter.get('/:id/members', requireGroupMember(req => req.params.id), async (req, res) => {
  try {
    const members = await Member.find({ group_id: req.params.id })
      .populate('user_id', 'full_name phone avatar_color avatar_url')
      .sort({ position: 1 });
    const isOwner = req.groupRole === 'owner';
    const normalizedMembers = members.map(member => {
      const row = member.toObject();
      const populatedUserId = member.populated('user_id');
      const user = row.user_id && typeof row.user_id === 'object' ? row.user_id : null;
      if (user?.full_name) {
        row.name = user.full_name;
        row.initials = initialsOf(user.full_name);
        row.phone = user.phone || row.phone;
      }
      row.avatar_url = user?.avatar_url ?? null;
      if (row.user_id) {
        const rawUserId = typeof row.user_id === 'object' ? row.user_id._id || row.user_id.id : row.user_id;
        row.user_id = rawUserId ? String(rawUserId) : null;
        if (row.user_id === '[object Object]') row.user_id = null;
      }
      if (populatedUserId) row.user_id = populatedUserId.toString();

      const isSelf = row.user_id && row.user_id === String(req.userId);
      if (!isOwner && !isSelf) {
        row.phone = null;
        delete row.guarantor_name;
        delete row.guarantor_phone;
        delete row.guarantor_address;
        delete row.guarantor_relationship;
      }
      return row;
    });
    res.json({ members: normalizedMembers });
  } catch (err) {
    serverError(res, err);
  }
});

groupsRouter.post('/:id/members', requireGroupMember(req => req.params.id), requireGroupOwner, async (req, res) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const position = Number(req.body?.position);
    if (!name || name.length > 100 || !Number.isInteger(position) || position < 1) {
      return res.status(400).json({ error: 'Name and a valid position are required' });
    }
    const role = req.body?.role === 'creator' ? 'member' : (typeof req.body?.role === 'string' ? req.body.role : 'member');
    const member = await Member.create({
      group_id: req.params.id,
      name, phone: normalizePhone(req.body?.phone),
      initials: initialsOf(name),
      position, role,
      paid_count: 0,
      status: 'pending',
      user_id: null,
    });
    await SeriesPosition.create({ group_id: req.params.id, member_id: member._id, position, reason: 'Initial assignment' });
    res.status(201).json({ member });
  } catch (err) {
    serverError(res, err);
  }
});

// Mark the first overdue pending schedule as missed and move its recipient
// to the end of the current queue.
groupsRouter.post('/:id/process-missed-payment', requireGroupMember(req => req.params.id), requireGroupOwner, async (req, res) => {
  try {
    const today = lagosToday();
    const schedule = await Schedule.findOne({
      group_id: req.params.id,
      status: 'pending',
      due_date: { $lt: today },
    }).sort({ due_date: 1, series_number: 1 });

    if (!schedule) return res.status(404).json({ error: 'No overdue pending payment found' });

    const member = await Member.findOne({
      group_id: req.params.id,
      position: schedule.series_number,
      status: { $nin: ['exited', 'exit_pending_replacement'] },
    });
    if (!member) {
      return res.status(409).json({ error: 'The overdue schedule does not map to an active member' });
    }

    const lastPosition = await Member.findOne({
      group_id: req.params.id,
      status: { $nin: ['exited', 'exit_pending_replacement'] },
    }).sort({ position: -1 }).select('position');
    const oldPosition = member.position;
    const newPosition = lastPosition?.position || oldPosition;

    schedule.status = 'missed';
    await schedule.save();

    if (oldPosition !== newPosition) {
      await Member.updateMany(
        { group_id: req.params.id, position: { $gt: oldPosition }, status: { $nin: ['exited', 'exit_pending_replacement'] } },
        { $inc: { position: -1 } },
      );
      await SeriesPosition.updateMany(
        { group_id: req.params.id, position: { $gt: oldPosition } },
        { $inc: { position: -1 } },
      );
      await Member.updateOne({ _id: member._id }, { $set: { position: newPosition } });
      await SeriesPosition.updateMany(
        { group_id: req.params.id, member_id: member._id },
        { $set: { position: newPosition, reason: `Missed payment in series ${schedule.series_number}` } },
      );
    }

    await Activity.create({
      group_id: req.params.id,
      member_id: member._id,
      type: 'missed_payment',
      title: `${member.name} missed their contribution`,
      status: 'missed',
      meta: `Series ${schedule.series_number}  ·  Moved to position ${newPosition}`,
    });

    res.json({ schedule, member });
  } catch (err) {
    serverError(res, err);
  }
});

// A member may leave before the cycle starts; once it has started, preserve
// the position until the owner assigns a replacement.
groupsRouter.post('/:id/members/:memberId/exit', requireGroupMember(req => req.params.id), async (req, res) => {
  try {
    const member = await Member.findOne({ group_id: req.params.id, _id: req.params.memberId });
    if (!member) return res.status(404).json({ error: 'Member not found' });
    if (req.groupRole !== 'owner' && String(member.user_id) !== String(req.userId)) {
      return res.status(403).json({ error: 'You can only exit your own membership' });
    }
    if (['exited', 'exit_pending_replacement'].includes(member.status)) {
      return res.status(409).json({ error: 'This member already has an exit request' });
    }

    if (req.group.current_series > 1) {
      member.status = 'exit_pending_replacement';
      await member.save();
      await Activity.create({
        group_id: req.params.id,
        member_id: member._id,
        type: 'member_exit',
        title: `${member.name} requested to exit`,
        status: 'pending',
        meta: 'Replacement required before this position can be released',
      });
      return res.json({ member, replacement_required: true });
    }

    const oldPosition = member.position;
    const refundAmount = member.paid_count * (req.group.contribution_amount || 0);
    await Activity.create({
      group_id: req.params.id,
      member_id: member._id,
      type: 'refund',
      title: `Refund owed to ${member.name}`,
      amount: refundAmount,
      status: 'owed',
      meta: `Member exited before cycle start  ·  ${member.paid_count} contributions`,
    });

    await Member.updateMany(
      { group_id: req.params.id, position: { $gt: oldPosition }, status: { $nin: ['exited', 'exit_pending_replacement'] } },
      { $inc: { position: -1 } },
    );
    await SeriesPosition.updateMany(
      { group_id: req.params.id, position: { $gt: oldPosition } },
      { $inc: { position: -1 } },
    );
    await Schedule.deleteOne({ group_id: req.params.id, status: 'pending', series_number: req.group.member_count });
    await Schedule.updateMany(
      { group_id: req.params.id, status: 'pending', series_number: { $gt: oldPosition } },
      { $inc: { series_number: -1 } },
    );
    await SeriesPosition.deleteMany({ group_id: req.params.id, member_id: member._id });
    await Member.deleteOne({ _id: member._id });
    req.group.member_count = Math.max(0, req.group.member_count - 1);
    await req.group.save();

    res.json({ exited_member_id: member._id, refund_amount: refundAmount, member_count: req.group.member_count });
  } catch (err) {
    serverError(res, err);
  }
});

// Replace an in-cycle member without changing the queue position or paid count.
groupsRouter.post('/:id/members/:memberId/replace', requireGroupMember(req => req.params.id), requireGroupOwner, async (req, res) => {
  try {
    const exitingMember = await Member.findOne({ group_id: req.params.id, _id: req.params.memberId, status: 'exit_pending_replacement' });
    if (!exitingMember) return res.status(404).json({ error: 'Exit-pending member not found' });
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 100) return res.status(400).json({ error: 'Replacement name is required' });

    let userId = null;
    if (req.body?.user_id) {
      if (!isObjectId(req.body.user_id)) return res.status(400).json({ error: 'Invalid user_id' });
      const exists = await User.exists({ _id: req.body.user_id });
      if (!exists) return res.status(404).json({ error: 'Replacement user not found' });
      const already = await Member.findOne({ group_id: req.params.id, user_id: req.body.user_id, status: 'active' });
      if (already) return res.status(409).json({ error: 'That user is already an active member of this group' });
      userId = req.body.user_id;
    }

    const replacement = await Member.create({
      group_id: req.params.id,
      user_id: userId,
      name,
      phone: normalizePhone(req.body?.phone),
      initials: initialsOf(name),
      position: exitingMember.position,
      role: 'member',
      paid_count: exitingMember.paid_count,
      status: 'active',
    });
    await SeriesPosition.updateMany(
      { group_id: req.params.id, member_id: exitingMember._id },
      { $set: { member_id: replacement._id, reason: `Replacement for ${exitingMember.name}` } },
    );
    exitingMember.status = 'exited';
    await exitingMember.save();
    await Activity.create({
      group_id: req.params.id,
      member_id: replacement._id,
      type: 'member_replacement',
      title: `${name} replaced ${exitingMember.name}`,
      status: 'completed',
      meta: `Position ${replacement.position}  ·  Paid count inherited: ${replacement.paid_count}`,
    });

    res.status(201).json({ member: replacement, replaced_member_id: exitingMember._id });
  } catch (err) {
    serverError(res, err);
  }
});

// Accept an invite: the logged-in user claims a pending Member row matching
// their phone number and flips it to active.
groupsRouter.post('/:id/join', async (req, res) => {
  try {
    const group = await Group.findById(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const alreadyMember = await Member.findOne({ group_id: group._id, user_id: req.userId, status: 'active' });
    if (alreadyMember) {
      return res.json({ member: alreadyMember, message: 'Already a member of this group' });
    }

    // A phone number is REQUIRED. Without it the old code matched ANY pending
    // invite in the group, letting a user take someone else's slot.
    const normalizedPhone = normalizePhone(user.phone);
    if (!normalizedPhone) {
      return res.status(400).json({ error: 'Add a phone number to your profile to accept invites' });
    }
    const pendingMember = await Member.findOne({ group_id: group._id, status: 'pending', phone: normalizedPhone });

    if (!pendingMember) {
      return res.status(404).json({ error: 'No pending invite found for you in this group' });
    }

    pendingMember.user_id = req.userId;
    pendingMember.name = user.full_name;
    pendingMember.initials = initialsOf(user.full_name);
    pendingMember.phone = normalizedPhone;
    pendingMember.status = 'active';
    await pendingMember.save();

    const existingInviteNotification = await Notification.findOne({
      user_id: req.userId,
      group_id: group._id,
      member_id: pendingMember._id,
      type: 'invite',
    });
    if (!existingInviteNotification) {
      await Notification.create({
        user_id: req.userId,
        group_id: group._id,
        member_id: pendingMember._id,
        type: 'invite',
        title: `You were invited to join ${group.name}`,
        body: `Accept this invite to join as ${pendingMember.name}.`,
        meta: { group_id: String(group._id) },
      });
    }

    await Activity.create({
      group_id: group._id,
      member_id: pendingMember._id,
      type: 'member',
      title: `${pendingMember.name} joined ${group.name}`,
      status: 'completed',
    });

    await Notification.create({
      user_id: group.owner_id,
      group_id: group._id,
      member_id: pendingMember._id,
      type: 'invite_accepted',
      title: `${pendingMember.name} joined ${group.name}`,
      body: 'They accepted your invite and are now an active member.',
      meta: { group_id: String(group._id) },
    });

    res.json({ member: pendingMember });
  } catch (err) {
    serverError(res, err);
  }
});

// Owner manually links a phone-less pending member to a real user account —
// recovers invites that were created with a name only (before phone was
// required) and have no way to be claimed via the normal /join flow.
groupsRouter.post('/:id/members/:memberId/link', requireGroupMember(req => req.params.id), requireGroupOwner, async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'A phone number is required to link this member' });

    const member = await Member.findOne({ _id: req.params.memberId, group_id: req.params.id });
    if (!member) return res.status(404).json({ error: 'Member not found' });
    if (member.user_id) return res.status(409).json({ error: 'This member is already linked to an account' });

    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) return res.status(400).json({ error: 'Enter a valid phone number' });
    const user = await User.findOne({ phone: normalizedPhone });
    if (!user) return res.status(404).json({ error: 'No Dashe account found with that phone number' });

    const alreadyMember = await Member.findOne({ group_id: req.params.id, user_id: user._id, status: 'active' });
    if (alreadyMember) return res.status(409).json({ error: 'That account is already an active member of this group' });

    member.user_id = user._id;
    member.name = user.full_name;
    member.initials = initialsOf(user.full_name);
    member.phone = normalizedPhone;
    member.status = 'active';
    await member.save();

    await Activity.create({
      group_id: req.params.id,
      member_id: member._id,
      type: 'member',
      title: `${member.name} was linked to their account`,
      status: 'completed',
      meta: 'Linked manually by group owner',
    });

    await Notification.create({
      user_id: user._id,
      group_id: req.params.id,
      member_id: member._id,
      type: 'invite_accepted',
      title: `You were added to ${req.group.name}`,
      body: 'The group owner linked your account. You can now message and contribute in this group.',
      meta: { group_id: String(req.params.id) },
    });

    res.json({ member });
  } catch (err) {
    serverError(res, err);
  }
});

groupsRouter.put('/:id/members/:memberId/guarantor', requireGroupMember(req => req.params.id), async (req, res) => {
  try {
    const b = req.body || {};
    const fields = ['guarantor_name', 'guarantor_phone', 'guarantor_address', 'guarantor_relationship'];
    if (!fields.every(k => typeof b[k] === 'string' && b[k].trim())) {
      return res.status(400).json({ error: 'All guarantor details are required' });
    }
    const guarantorPhone = normalizePhone(b.guarantor_phone);
    if (!guarantorPhone) return res.status(400).json({ error: 'Enter a valid guarantor phone number' });
    const member = await Member.findOneAndUpdate(
      { _id: req.params.memberId, group_id: req.params.id, user_id: req.userId, status: 'active' },
      {
        guarantor_name: b.guarantor_name.trim().slice(0, 100),
        guarantor_phone: guarantorPhone,
        guarantor_address: b.guarantor_address.trim().slice(0, 300),
        guarantor_relationship: b.guarantor_relationship.trim().slice(0, 50),
      },
      { new: true },
    );
    if (!member) return res.status(404).json({ error: 'Your active membership was not found' });
    res.json({ member });
  } catch (err) {
    serverError(res, err);
  }
});

groupsRouter.get('/:id/series-positions', requireGroupMember(req => req.params.id), async (req, res) => {
  try {
    const positions = await SeriesPosition.find({ group_id: req.params.id }).sort({ position: 1 });
    res.json({ positions });
  } catch (err) {
    serverError(res, err);
  }
});

groupsRouter.get('/:id/schedule', requireGroupMember(req => req.params.id), async (req, res) => {
  try {
    const schedule = await Schedule.find({ group_id: req.params.id }).sort({ series_number: 1 });
    res.json({ schedule });
  } catch (err) {
    serverError(res, err);
  }
});