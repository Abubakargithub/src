import { Group } from '../models/Group.js';
import { Member } from '../models/Member.js';

// Strict ObjectId check: only a 24-char hex STRING passes. Objects such as
// { $ne: 'x' } (from ?group_id[$ne]=x or a JSON body) are rejected.
export const isObjectId = v => typeof v === 'string' && /^[a-f\d]{24}$/i.test(v);

/**
 * Core membership check, reusable inside any handler (not just as middleware).
 * A user has access to a group if they are:
 *   - the owner, OR
 *   - a Member row on that group with status === 'active'
 *     (i.e. they were invited AND have accepted the invite)
 *
 * Pending / not-yet-accepted invitations do NOT grant access.
 */
export async function checkGroupMembership(rawGroupId, userId) {
  if (!isObjectId(rawGroupId)) return { ok: false, status: 400, error: 'A valid group_id is required' };
  const groupId = rawGroupId;

  const group = await Group.findById(groupId);
  if (!group) return { ok: false, status: 404, error: 'Group not found' };

  if (String(group.owner_id) === String(userId)) {
    return { ok: true, group, role: 'owner' };
  }

  const member = await Member.findOne({ group_id: groupId, user_id: userId, status: 'active' });
  if (!member) {
    return { ok: false, status: 403, error: 'You must be an accepted member of this group to view it' };
  }

  return { ok: true, group, member, role: member.role || 'member' };
}

/**
 * Express middleware. Pass a function that extracts the group id from the request
 * (params, query, or body — wherever the route expects it).
 *
 * On success, attaches:
 *   req.group     -> the Group document
 *   req.member    -> the Member document (undefined if the requester is the owner)
 *   req.groupRole -> 'owner' | the member's role
 */
export function requireGroupMember(getGroupId) {
  return async (req, res, next) => {
    try {
      const groupId = getGroupId(req);
      const result = await checkGroupMembership(groupId, req.userId);
      if (!result.ok) {
        return res.status(result.status).json({ error: result.error });
      }
      req.group = result.group;
      req.member = result.member;
      req.groupRole = result.role;
      next();
    } catch (err) {
      console.error('[groupAccess] failed:', err);
      res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  };
}

/**
 * Stricter variant: only the group owner may proceed.
 * Chain this AFTER requireGroupMember on routes where the action
 * (inviting members, triggering payouts, etc.) should be owner-only.
 */
export function requireGroupOwner(req, res, next) {
  if (req.groupRole !== 'owner') {
    return res.status(403).json({ error: 'Only the group owner can perform this action' });
  }
  next();
}