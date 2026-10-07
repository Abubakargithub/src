import { Router } from 'express';
import { Message } from '../models/Message.js';
import { Member } from '../models/Member.js';
import { Notification } from '../models/Notification.js';
import { User } from '../models/User.js';
import { authMiddleware } from '../middleware/auth.js';
import { checkGroupMembership, isObjectId } from '../middleware/groupAccess.js';

export const messagesRouter = Router();
messagesRouter.use(authMiddleware);

const MAX_TEXT = 2000;
const str = v => (typeof v === 'string' ? v : '');

function serverError(res, err) {
  console.error('[messages]', err);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

async function assertConversation(groupId, userId, otherUserId) {
  const access = await checkGroupMembership(groupId, userId);
  if (!access.ok) return access;

  const otherAccess = await checkGroupMembership(groupId, otherUserId);
  if (!otherAccess.ok) {
    return { ok: false, status: 403, error: 'You can only message active members of your group' };
  }

  return { ok: true };
}

async function resolveMemberConversation(groupId, memberId, senderId) {
  if (!isObjectId(groupId)) return { error: 'A valid group_id is required', status: 400 };
  if (!isObjectId(memberId)) return { error: 'Invalid member ID', status: 400 };
  const access = await checkGroupMembership(groupId, senderId);
  if (!access.ok) return { error: access.error, status: access.status };
  const member = await Member.findOne({ _id: memberId, group_id: groupId, status: 'active' });
  if (!member?.user_id) return { error: 'This member has not linked an account yet', status: 400 };
  if (String(member.user_id) === String(senderId)) return { error: 'You cannot message yourself', status: 400 };
  const conversation = await assertConversation(groupId, senderId, member.user_id);
  if (!conversation.ok) return { error: conversation.error, status: conversation.status };
  return { userId: String(member.user_id) };
}

// Latest 200 messages, returned oldest-first for display.
async function loadThread(groupId, me, other) {
  const latest = await Message.find({
    group_id: groupId,
    $or: [{ sender_id: me, recipient_id: other }, { sender_id: other, recipient_id: me }],
  }).sort({ created_at: -1 }).limit(200);
  await Message.updateMany(
    { group_id: groupId, sender_id: other, recipient_id: me, read_at: null },
    { read_at: new Date() },
  );
  return latest.reverse();
}

async function storeMessage(groupId, me, other, rawText) {
  const text = String(rawText).trim();
  const sender = await User.findById(me);
  if (!sender) return { status: 404, error: 'User not found' };
  const message = await Message.create({ group_id: groupId, sender_id: me, recipient_id: other, text });
  await Notification.create({
    user_id: other,
    group_id: groupId,
    type: 'direct_message',
    title: `New message from ${sender.full_name}`,
    body: text.slice(0, 120),
    meta: { group_id: String(groupId), sender_id: String(me) },
  });
  return { message };
}

function validText(raw) {
  const text = str(raw).trim();
  if (!text) return { error: 'group_id and message text are required' };
  if (text.length > MAX_TEXT) return { error: `Messages are limited to ${MAX_TEXT} characters` };
  return { text };
}

messagesRouter.get('/member/:memberId', async (req, res) => {
  try {
    const groupId = str(req.query.group_id);
    const resolved = await resolveMemberConversation(groupId, req.params.memberId, req.userId);
    if (resolved.error) return res.status(resolved.status || 400).json({ error: resolved.error });
    const messages = await loadThread(groupId, req.userId, resolved.userId);
    res.json({ messages });
  } catch (err) { serverError(res, err); }
});

messagesRouter.post('/member/:memberId', async (req, res) => {
  try {
    const groupId = str(req.body?.group_id);
    const v = validText(req.body?.text);
    if (!groupId || v.error) return res.status(400).json({ error: v.error || 'group_id and message text are required' });
    const resolved = await resolveMemberConversation(groupId, req.params.memberId, req.userId);
    if (resolved.error) return res.status(resolved.status || 400).json({ error: resolved.error });
    const out = await storeMessage(groupId, req.userId, resolved.userId, v.text);
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.status(201).json({ message: out.message });
  } catch (err) { serverError(res, err); }
});

messagesRouter.get('/:userId', async (req, res) => {
  try {
    if (!isObjectId(req.params.userId)) return res.status(400).json({ error: 'Invalid recipient ID' });
    const groupId = str(req.query.group_id);
    if (!groupId) return res.status(400).json({ error: 'group_id is required' });
    const access = await assertConversation(groupId, req.userId, req.params.userId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const messages = await loadThread(groupId, req.userId, req.params.userId);
    res.json({ messages });
  } catch (err) { serverError(res, err); }
});

messagesRouter.post('/:userId', async (req, res) => {
  try {
    if (!isObjectId(req.params.userId)) return res.status(400).json({ error: 'Invalid recipient ID' });
    const groupId = str(req.body?.group_id);
    const v = validText(req.body?.text);
    if (!groupId || v.error) return res.status(400).json({ error: v.error || 'group_id and message text are required' });
    if (String(req.params.userId) === String(req.userId)) return res.status(400).json({ error: 'You cannot message yourself' });
    const access = await assertConversation(groupId, req.userId, req.params.userId);
    if (!access.ok) return res.status(access.status).json({ error: access.error });
    const recipient = await User.exists({ _id: req.params.userId });
    if (!recipient) return res.status(404).json({ error: 'User not found' });
    const out = await storeMessage(groupId, req.userId, req.params.userId, v.text);
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.status(201).json({ message: out.message });
  } catch (err) { serverError(res, err); }
});