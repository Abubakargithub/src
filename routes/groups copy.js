import { Router } from 'express';
import { Group } from '../models/Group.js';
import { Member } from '../models/Member.js';
import { SeriesPosition } from '../models/SeriesPosition.js';
import { Schedule } from '../models/Schedule.js';
import { Activity } from '../models/Activity.js';
import { authMiddleware } from '../middleware/auth.js';

export const groupsRouter = Router();

groupsRouter.use(authMiddleware);

groupsRouter.get('/', async (req, res) => {
  try {
    const owned = await Group.find({ owner_id: req.userId }).sort({ created_at: 1 });
    const joinedMemberships = await Member.find({ user_id: req.userId }).select('group_id');
    const joinedGroupIds = joinedMemberships.map(m => m.group_id);
    const joinedGroups = await Group.find({ _id: { $in: joinedGroupIds }, owner_id: { $ne: req.userId } }).sort({ created_at: 1 });
    res.json({ groups: [...owned, ...joinedGroups] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

groupsRouter.get('/:id', async (req, res) => {
  try {
    const group = await Group.findById(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    res.json({ group });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

groupsRouter.post('/', async (req, res) => {
  try {
    const { name, description, category, contribution_amount, frequency, member_count, start_date, contribution_day, fee_payer } = req.body;
    if (!name || !contribution_amount || !frequency) {
      return res.status(400).json({ error: 'Name, contribution amount, and frequency are required' });
    }
    const group = await Group.create({
      name, description: description || null,
      category: category || 'Family',
      contribution_amount, frequency,
      member_count: member_count || 6,
      start_date: start_date || null,
      contribution_day: contribution_day || 'Saturday',
      fee_payer: fee_payer || 'Member pays',
      status: 'upcoming', current_series: 1,
      owner_id: req.userId,
    });

    const user = await import('../models/User.js').then(m => m.User.findById(req.userId));
    const creatorName = user?.full_name || 'You';
    const initials = creatorName.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();

    const member = await Member.create({
      group_id: group._id,
      user_id: req.userId,
      name: creatorName,
      initials,
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
      meta: `${category || 'Family'}  ·  ₦${contribution_amount.toLocaleString()} ${frequency}  ·  ${member_count || 6} members`,
    });

    if (start_date) {
      const rows = [];
      const start = new Date(start_date);
      const dayMap = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
      const targetDay = dayMap[contribution_day] ?? 0;
      const diff = (targetDay - start.getDay() + 7) % 7;
      start.setDate(start.getDate() + diff);
      const intervalDays = frequency === 'Daily' ? 1 : frequency === 'Weekly' ? 7 : 30;
      for (let i = 0; i < (member_count || 6); i++) {
        const due = new Date(start);
        due.setDate(due.getDate() + i * intervalDays);
        rows.push({ group_id: group._id, series_number: i + 1, due_date: due.toISOString().slice(0, 10), status: 'pending' });
      }
      await Schedule.insertMany(rows);
    }

    res.status(201).json({ group });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

groupsRouter.get('/:id/members', async (req, res) => {
  try {
    const members = await Member.find({ group_id: req.params.id }).sort({ position: 1 });
    res.json({ members });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

groupsRouter.post('/:id/members', async (req, res) => {
  try {
    const { name, phone, initials, position, role } = req.body;
    if (!name || position === undefined) {
      return res.status(400).json({ error: 'Name and position are required' });
    }
    const member = await Member.create({
      group_id: req.params.id,
      name, phone: phone || null,
      initials: initials || name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase(),
      position, role: role || 'member',
      paid_count: 0, status: 'pending',
      user_id: role === 'creator' ? req.userId : null,
    });
    await SeriesPosition.create({ group_id: req.params.id, member_id: member._id, position, reason: 'Initial assignment' });
    res.status(201).json({ member });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

groupsRouter.get('/:id/series-positions', async (req, res) => {
  try {
    const positions = await SeriesPosition.find({ group_id: req.params.id }).sort({ position: 1 });
    res.json({ positions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

groupsRouter.get('/:id/schedule', async (req, res) => {
  try {
    const schedule = await Schedule.find({ group_id: req.params.id }).sort({ series_number: 1 });
    res.json({ schedule });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
