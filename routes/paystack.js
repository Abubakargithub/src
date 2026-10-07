import { Router } from 'express';
import axios from 'axios';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { Contribution } from '../models/Contribution.js';
import { Member } from '../models/Member.js';
import { Activity } from '../models/Activity.js';
import { Group } from '../models/Group.js';
import { User } from '../models/User.js';
import { DVA } from '../models/DVA.js';
import { TransferRecipient } from '../models/TransferRecipient.js';
import { Transfer } from '../models/Transfer.js';
import { Schedule } from '../models/Schedule.js';
import { Notification } from '../models/Notification.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireGroupMember, requireGroupOwner } from '../middleware/groupAccess.js';
import { contributionFee, feePercent, grossPool, payoutFee, payoutNet } from '../lib/fees.js';
import { lagosToday } from '../utils/date.js';
import { Dispute } from '../models/Dispute.js';
export const paystackRouter = Router();

// ============================================================
// Money flow (read this first)
//
//  1. Members pay into their Paystack dedicated virtual account (DVA).
//     Those funds land in Dashe's Paystack balance = the settlement account.
//     Nothing is ever paid out to anyone at this stage.
//  2. A contribution is recorded ONLY when Paystack confirms the money
//     arrived (webhook, re-verified with Paystack). Members who have not
//     paid simply have no contribution record and show as unpaid/missed.
//     If a webhook is missed, reconcileDvaCredits() finds the charge by
//     polling Paystack and replays it through the same handler.
//  3. The group owner (or the automatic runner) releases the cash-out once
//     EVERYONE has paid or the due date (Lagos time) has passed. It goes ONLY
//     to the member whose turn it is (position === current_series), ONLY if
//     that member has paid their own contribution for the series, ONLY if
//     their identity is verified, and ONLY for money actually collected
//     (minus the service fee for 'Shared' groups) — never more than received.
//  4. Collected money is not spendable until Paystack SETTLES it (usually
//     T+1). If the balance is not there yet, the payout is simply skipped
//     and retried on the next automatic run. Nothing is sent, nothing is
//     saved, and it does NOT count as a failed attempt.
//
// Identity (BVN) verification is asynchronous:
//   POST /identity/verify  -> Paystack customer validation, user becomes 'pending'
//   webhook customeridentification.success | .failed -> user becomes 'verified' | 'failed'
//   POST /identity/check   -> fallback: asks Paystack whether the customer is
//                             identified, for missed webhooks / local testing
//
// Env: PAYSTACK_SECRET_KEY, PAYSTACK_CALLBACK_URL,
//      PAYSTACK_VERIFY_CHARGES (default true), REQUIRE_ACCOUNT_NAME_MATCH
//      (default true in production), RECIPIENT_COOLDOWN_HOURS
//      (default 24 in production, 0 otherwise),
//      REQUIRE_IDENTITY_VERIFICATION (default true in production),
//      IDENTITY_HASH_KEY (optional; defaults to the Paystack secret key).
//
// User schema fields used here: identity_type, identity_status,
// identity_reference, identity_verified_at, identity_name, identity_hash,
// identity_pending_hash.
// ============================================================

const PAYSTACK_BASE = 'https://api.paystack.co';
const SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PAYOUT_STATUSES = ['pending', 'otp', 'success']; // transfers that count as "payout already made/in flight"
const MAX_AUTO_PAYOUT_FAILURES = 3;
const OWNER_ALERT_CODES = ['no_account', 'no_recipient', 'identity_unverified'];
const DVA_RECONCILE_WINDOW_HOURS = 48;
function paystackHeaders() {
  return {
    Authorization: `Bearer ${SECRET_KEY}`,
    'Content-Type': 'application/json',
  };
}

function isConfigured() {
  return SECRET_KEY && !SECRET_KEY.startsWith('sk_test_xxx');
}

const identityRequired = () =>
  process.env.REQUIRE_IDENTITY_VERIFICATION
    ? process.env.REQUIRE_IDENTITY_VERIFICATION === 'true'
    : process.env.NODE_ENV === 'production';

async function paystackGet(path) {
  const r = await axios.get(`${PAYSTACK_BASE}${path}`, { headers: paystackHeaders(), timeout: 15000 });
  return r.data;
}

async function paystackPost(path, body) {
  const r = await axios.post(`${PAYSTACK_BASE}${path}`, body, { headers: paystackHeaders(), timeout: 15000 });
  return r.data;
}

const isId = v => typeof v === 'string' && /^[a-f\d]{24}$/i.test(v);
const isDuplicateKey = err => err?.code === 11000;
const today = lagosToday; // Nigerian calendar date
const dateKey = d => (d instanceof Date ? d.toISOString() : String(d || '')).slice(0, 10);
const kobo = naira => Math.round(Number(naira) * 100);

// Never leak internals to clients; log the detail server-side.
function serverError(res, err, message = 'Something went wrong. Please try again.') {
  console.error(`[paystack] ${message}:`, err?.response?.data || err?.message || err);
  return res.status(500).json({ error: message });
}

// Create the Paystack customer for a user, or find the existing one by email.
async function getOrCreatePaystackCustomer(user) {
  try {
    const cust = await paystackPost('/customer', {
      email: user.email,
      first_name: user.full_name.split(' ')[0] || 'Dashe',
      last_name: user.full_name.split(' ').slice(1).join(' ') || 'User',
      phone: user.phone || '',
      metadata: { user_id: String(user._id) },
    });
    return cust.data.customer_code;
  } catch {
    // Customer may already exist — try to find by email
    const list = await paystackGet(`/customer?email=${encodeURIComponent(user.email)}`);
    return list.data && list.data.length > 0 ? list.data[0].customer_code : null;
  }
}

// Best-effort in-app notice. Never lets a notification problem break the caller.
async function notifyUser(userId, title, body) {
  try {
    await Notification.create({ user_id: userId, type: 'identity', title, body, meta: {} });
  } catch (err) {
    console.error('[paystack] could not create notification:', err?.message || err);
  }
}

// ============================================================
// Contribution recording (exactly once, only for money really received)
// ============================================================

async function recordPaidContribution({ group_id, member_id, member_name, series_number, amount, payment_method, reference, source, note }) {
  const series = Number(series_number) || 1;

  const byReference = reference ? await Contribution.findOne({ reference }) : null;
  if (byReference) return { contribution: byReference, created: false };

  const bySeries = await Contribution.findOne({ group_id, member_id, series_number: series, status: { $in: ['pending', 'completed'] } });
  if (bySeries) return { contribution: bySeries, created: false };

  const schedule = await Schedule.findOne({ group_id, series_number: series });

  let contribution;
  try {
    contribution = await Contribution.create({
      group_id, member_id, member_name: member_name || 'Unknown',
      series_number: series, amount,
      status: 'completed', payment_method: payment_method || 'card',
      due_date: schedule?.due_date || today(),
      paid_at: new Date(), reference: reference || null, paystack_reference: reference || null,
    });
  } catch (err) {
    if (isDuplicateKey(err)) {
      const dup = await Contribution.findOne({ $or: [{ reference }, { group_id, member_id, series_number: series, status: 'completed' }] });
      return { contribution: dup, created: false };
    }
    throw err;
  }

  await Member.findByIdAndUpdate(member_id, { $inc: { paid_count: 1 }, status: 'active' });

  const activeMemberCount = await Member.countDocuments({ group_id, status: { $in: ['active', 'pending'] } });
  const paidMemberCount = await Contribution.countDocuments({ group_id, series_number: series, status: 'completed' });
  if (schedule && paidMemberCount >= activeMemberCount) {
    schedule.status = 'completed';
    await schedule.save();
  }

  await Activity.create({
    group_id, member_id,
    type: 'contribution',
    title: `${member_name || 'Member'} contributed ₦${Number(amount).toLocaleString()}`,
    amount, status: 'completed',
    payment_method: payment_method || 'card', reference: reference || null,
    meta: `Series ${series}  ·  ${(payment_method || 'card').toUpperCase()}  ·  ${source || 'Paystack'}${note ? `  ·  ${note}` : ''}`,
  });

  return { contribution, created: true };
}

// ============================================================
// Series state, payout eligibility and payout execution
// ============================================================

// Who has actually paid for the group's current series.
// Only contributions confirmed by Paystack (they carry a paystack_reference) count.
async function getSeriesState(group) {
  const series = group.current_series;
  const members = await Member.find({ group_id: group._id, status: { $nin: ['exited', 'exit_pending_replacement'] } });
  const paid = await Contribution.find({ group_id: group._id, series_number: series, status: 'completed', paystack_reference: { $type: 'string' } });
  const paidIds = new Set(paid.map(c => String(c.member_id)));
  const unpaid = members.filter(m => !paidIds.has(String(m._id)));
  const collected = paid.reduce((sum, c) => sum + (Number(c.amount) || 0), 0);
  const turnMember = members.find(m => m.position === series) || null;
  return {
    series, members, paid, unpaid, collected, turnMember,
    turnPaid: turnMember ? paidIds.has(String(turnMember._id)) : false,
  };
}

// Spendable (settled) NGN balance in kobo. Money still in settlement is NOT included.
async function getNgnBalanceKobo() {
  const body = await paystackGet('/balance');
  const ngn = (body.data || []).find(b => b.currency === 'NGN');
  return ngn ? Number(ngn.balance) || 0 : 0;
}

// Decide whether the cash-out for the current series can be released, and how much.
// Manual and automatic release share ONE rule: everyone has paid OR the due date has passed.
async function preparePayout(group, { requireDue }) {
  const state = await getSeriesState(group);
  const { series, turnMember, turnPaid, collected, unpaid } = state;
  const fail = (code, message, extra = {}) => ({ ok: false, code, message, state, ...extra });

  if (!turnMember) return fail('no_turn_member', `No member found for Series ${series}.`);
  if (!turnMember.user_id) return fail('no_account', `${turnMember.name} has no linked Dashe account yet.`);

  const turnUser = await User.findById(turnMember.user_id).select('identity_status');
  if (!turnUser) return fail('no_account', `${turnMember.name} has no linked Dashe account yet.`);
  if (identityRequired() && turnUser.identity_status !== 'verified') {
    return fail('identity_unverified', `${turnMember.name} must complete identity verification before cashing out.`);
  }

  const existing = await Transfer.findOne({ group_id: group._id, series_number: series, status: { $in: PAYOUT_STATUSES } });
  if (existing) return fail('already_paid', `Cash-out for Series ${series} has already been initiated.`, { existing });

  // Rule: only the member whose turn it is, and only after paying their own contribution.
  if (!turnPaid) return fail('turn_member_unpaid', `${turnMember.name} must pay their own Series ${series} contribution before cashing out.`);

  const schedule = await Schedule.findOne({ group_id: group._id, series_number: series });
  const dueReached = schedule ? dateKey(schedule.due_date) <= today() : false;
  const everyonePaid = unpaid.length === 0;
  if (!dueReached && !everyonePaid) {
    return fail('not_due', `Series ${series} is not due yet and ${unpaid.length} member(s) have not paid. Cash-out can be released once everyone has paid or the due date passes.`);
  }

  if (requireDue) {
    const failures = await Transfer.countDocuments({ group_id: group._id, series_number: series, status: 'failed' });
    if (failures >= MAX_AUTO_PAYOUT_FAILURES) return fail('too_many_failures', 'Automatic payout paused after repeated failures — the group owner must release it manually.');
  }

  // Only money actually received is paid out.
  const gross = collected;
  if (gross <= 0) return fail('nothing_collected', 'No contributions have been received for this series.');
  const fee = payoutFee(group, gross);
  const net = payoutNet(group, gross);
  if (net <= 0) return fail('nothing_to_pay', 'Nothing left to pay out after fees.');

  const recipient = await TransferRecipient.findOne({ user_id: turnMember.user_id, is_verified: true }).sort({ created_at: -1 });
  if (!recipient?.paystack_recipient_code) return fail('no_recipient', `${turnMember.name} has not added a verified bank account.`);

  // A freshly added bank account cannot receive money straight away (account-takeover guard).
  const cooldownHours = Number(process.env.RECIPIENT_COOLDOWN_HOURS ?? (process.env.NODE_ENV === 'production' ? 24 : 0));
  if (cooldownHours > 0 && recipient.created_at && Date.now() - new Date(recipient.created_at).getTime() < cooldownHours * 3600 * 1000) {
    return fail('recipient_cooldown', `${turnMember.name} added a new bank account recently. Payouts to it unlock after ${cooldownHours} hours.`);
  }

  return { ok: true, state, member: turnMember, recipient, gross, fee, net, series };
}

// Sends the transfer. Pass { availableKobo } to check against a balance the caller
// already fetched (the automatic runner does this so several groups in one run cannot
// each "spend" the same money). Without it, the live balance is fetched.
async function initiatePayout(group, plan, { availableKobo } = {}) {
  const { member, recipient, gross, fee, net, series } = plan;

  // Funds must already have SETTLED into the Paystack balance.
  const needKobo = kobo(net);
  const balance = availableKobo ?? await getNgnBalanceKobo();
  if (balance < needKobo) {
    const err = new Error('Collected funds have not settled into the payout balance yet. Try again shortly.');
    err.code = 'insufficient_balance';
    err.needKobo = needKobo;
    err.balanceKobo = balance;
    throw err;
  }

  // Deterministic reference: a concurrent duplicate attempt gets rejected by Paystack.
  const attempt = (await Transfer.countDocuments({ group_id: group._id, series_number: series })) + 1;
  const reference = `dashe-po-${group._id}-s${series}-a${attempt}`;
  const reason = `Dashe cash-out — ${group.name} — Series ${series}`;

  let body;
  try {
    body = await paystackPost('/transfer', {
      source: 'balance',
      amount: needKobo,
      recipient: recipient.paystack_recipient_code,
      reason,
      reference,
    });
  } catch (err) {
    // Timeout / network error: Paystack may have accepted the transfer anyway.
    // Look it up by reference so we never end up with money sent but nothing recorded.
    if (err.response) throw err;
    try {
      body = await paystackGet(`/transfer/verify/${encodeURIComponent(reference)}`);
    } catch {
      throw err;
    }
  }
  const transferData = body.data;

  let transfer;
  try {
    transfer = await Transfer.create({
      group_id: group._id,
      member_id: member._id,
      user_id: member.user_id,
      recipient_code: recipient.paystack_recipient_code,
      amount: net,
      gross_amount: gross,
      service_fee: fee,
      reason,
      reference,
      paystack_transfer_code: transferData.transfer_code || transferData.code,
      status: transferData.status || 'pending',
      series_number: series,
      paystack_response: JSON.stringify(transferData),
    });
  } catch (err) {
    // Money has been sent but we failed to record it — make this loud.
    console.error(`[paystack] CRITICAL: transfer ${reference} sent but not saved`, err);
    throw err;
  }

  await Activity.create({
    group_id: group._id,
    member_id: member._id,
    type: 'cashout',
    title: `${member.name} cash-out initiated`,
    amount: net,
    status: transferData.status || 'pending',
    payment_method: 'bank_transfer',
    reference,
    meta: `Series ${series}  ·  ${feePercent(group)}% fee ₦${fee.toLocaleString()} (${group.fee_payer || 'Shared'})  ·  ${plan.state.paid.length}/${plan.state.members.length} paid`,
  });

  return transfer;
}

// Tell the owner (once per day per series) when an automatic payout is due but blocked.
async function alertOwnerBlocked(group, plan) {
  try {
    const series = plan.state.series;
    const schedule = await Schedule.findOne({ group_id: group._id, series_number: series });
    if (!schedule || dateKey(schedule.due_date) > today()) return;
    const key = `payout_blocked:${plan.code}:${group._id}:${series}:${today()}`;
    if (await Notification.exists({ user_id: group.owner_id, 'meta.reminder_key': key })) return;
    await Notification.create({
      user_id: group.owner_id,
      group_id: group._id,
      type: 'payout_blocked',
      title: `Cash-out for ${group.name} is on hold`,
      body: plan.message,
      meta: { group_id: String(group._id), series_number: series, reminder_key: key },
    });
  } catch (err) {
    console.error('[paystack] owner alert failed:', err?.message || err);
  }
}

// Tells the people involved that the cash-out is only waiting for bank settlement.
// Shows in the dashboard's activity feed (group-wide) and as a notification for the
// member whose turn it is. Once per group/series; best-effort, never breaks the runner.
async function noticeSettlementWait(group, plan) {
  try {
    const key = `settlement-wait-${group._id}-s${plan.series}`;
    if (await Activity.exists({ reference: key })) return;

    await Activity.create({
      group_id: group._id,
      member_id: plan.member._id,
      type: 'cashout',
      title: `${plan.member.name}'s cash-out is waiting for bank settlement`,
      amount: plan.net,
      status: 'pending',
      payment_method: 'bank_transfer',
      reference: key,
      meta: `Series ${plan.series}  ·  Payments usually settle within 24 hours, then the cash-out is sent automatically`,
    });

    if (plan.member.user_id) {
      await Notification.create({
        user_id: plan.member.user_id,
        group_id: group._id,
        type: 'payout_pending',
        title: `Your cash-out from ${group.name} is on its way`,
        body: `The contributions are still settling with our payment partner (usually within 24 hours). Your ₦${Number(plan.net).toLocaleString()} will be sent automatically once they land.`,
        meta: { group_id: String(group._id), series_number: plan.series, reminder_key: key },
      });
    }
  } catch (err) {
    console.error('[paystack] could not record settlement-wait notice:', err?.message || err);
  }
}

// Groups already reported as "waiting for settlement", so the log says it once
// per group/series instead of on every run. Cleared when the payout goes through.
const waitingForSettlement = new Set();

export async function runAutomaticPayouts() {
  if (!isConfigured()) return;
  const groups = await Group.find({ status: { $in: ['active', 'upcoming'] } });

  // Fetched lazily (only if some group is actually ready to pay) and shared across
  // the whole run, then reduced after each transfer so groups cannot double-spend it.
  let availableKobo = null;

  for (const group of groups) {
    let plan = null;
    try {
      plan = await preparePayout(group, { requireDue: true });
      if (!plan.ok) {
        if (OWNER_ALERT_CODES.includes(plan.code)) await alertOwnerBlocked(group, plan);
        continue;
      }

      if (availableKobo === null) availableKobo = await getNgnBalanceKobo();

      await initiatePayout(group, plan, { availableKobo });
      availableKobo -= kobo(plan.net);
      waitingForSettlement.delete(`${group._id}:${plan.series}`);
    } catch (err) {
      // Not a failure: the money is collected but Paystack has not settled it yet.
      // Nothing was sent or saved, so the next run simply tries again.
      if (err.code === 'insufficient_balance') {
        if (plan?.ok) await noticeSettlementWait(group, plan);
        const key = `${group._id}:${group.current_series}`;
        if (!waitingForSettlement.has(key)) {
          waitingForSettlement.add(key);
          console.log(`[paystack] payout for group ${group._id} (series ${group.current_series}) is waiting for funds to settle — will retry automatically`);
        }
        continue;
      }
      // One failing group must not stop payouts for the rest.
      console.error(`[paystack] automatic payout failed for group ${group._id}:`, err.response?.data?.message || err.message);
    }
  }
}

// Safety net for missed webhooks: ask Paystack about transfers stuck in pending/otp.
export async function reconcilePendingTransfers() {
  if (!isConfigured()) return;
  const cutoff = new Date(Date.now() - 10 * 60 * 1000);
  const stuck = await Transfer.find({ status: { $in: ['pending', 'otp'] }, created_at: { $lt: cutoff } }).limit(50);
  for (const t of stuck) {
    try {
      const body = await paystackGet(`/transfer/verify/${encodeURIComponent(t.reference)}`);
      const s = body.data?.status;
      const data = { ...body.data, reference: t.reference };
      if (s === 'success') await handleTransferEvent({ event: 'transfer.success', data });
      else if (s === 'failed' || s === 'reversed') await handleTransferEvent({ event: 'transfer.failed', data });
    } catch (err) {
      console.error(`[paystack] reconcile failed for ${t.reference}:`, err.response?.data?.message || err.message);
    }
  }
}

// Safety net for missed DVA webhooks (and local dev without a tunnel).
// For every customer that still has an OPEN DVA, list their recent successful
// transactions from Paystack and replay the bank-transfer credits we have not
// processed yet through handleDvaCredit — the same idempotent path the webhook
// uses (re-verified with Paystack, deduped by reference, amount-matched to a DVA).
// Pass { userId } to limit it to one user's DVAs.
export async function reconcileDvaCredits({ userId, hours = DVA_RECONCILE_WINDOW_HOURS } = {}) {
  const result = { customers: 0, replayed: 0 };
  if (!isConfigured()) return result;

  const filter = { status: 'active', paystack_customer_code: { $type: 'string' } };
  if (userId) filter.user_id = userId;
  const openDvas = await DVA.find(filter).select('paystack_customer_code');
  const codes = [...new Set(openDvas.map(d => d.paystack_customer_code))];
  const from = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  for (const code of codes) {
    result.customers++;
    try {
      // The transaction list filters by numeric customer id, not customer code.
      const customer = await paystackGet(`/customer/${encodeURIComponent(code)}`);
      const customerId = customer.data?.id;
      if (!customerId) continue;

      const list = await paystackGet(`/transaction?customer=${customerId}&status=success&perPage=50&from=${encodeURIComponent(from)}`);
      const credits = (list.data || []).filter(t => t.channel === 'dedicated_nuban' && t.currency === 'NGN' && t.reference);
      if (credits.length === 0) continue;

      const known = await DVA.find({ paystack_customer_code: code }).select('processed_references');
      const seen = new Set(known.flatMap(d => d.processed_references || []));

      for (const t of credits) {
        if (seen.has(t.reference)) continue;
        // Already flagged for manual review: don't reprocess (and re-log) every run.
        if (await Activity.exists({ reference: t.reference, type: 'unallocated_funds' })) continue;
        await handleDvaCredit({ ...t, customer: { ...(t.customer || {}), customer_code: code } });
        result.replayed++;
      }
    } catch (err) {
      console.error(`[paystack] DVA reconcile failed for customer ${code}:`, err.response?.data?.message || err.message);
    }
  }
  return result;
}
//
// ============================================================
// Payout help: re-check / retry a cash-out, and report a dispute
// ============================================================

const RECHECK_COOLDOWN_MS = 2 * 60 * 1000;

// Asks Paystack about a transfer stuck in pending/otp and applies the result.
async function syncTransfer(transfer) {
  try {
    const body = await paystackGet(`/transfer/verify/${encodeURIComponent(transfer.reference)}`);
    const s = body.data?.status;
    const data = { ...body.data, reference: transfer.reference };
    if (s === 'success') await handleTransferEvent({ event: 'transfer.success', data });
    else if (s === 'failed' || s === 'reversed') await handleTransferEvent({ event: 'transfer.failed', data });
  } catch (err) {
    console.error(`[paystack] sync failed for ${transfer.reference}:`, err.response?.data?.message || err.message);
  }
  return Transfer.findById(transfer._id);
}

// The turn member or the group owner can re-check the current series' cash-out.
// Same rules as the automatic runner: server decides recipient and amount.
paystackRouter.post('/payout-check/:groupId', authMiddleware, requireGroupMember(req => req.params.groupId), async (req, res) => {
  try {
    if (!isConfigured()) return res.status(503).json({ error: 'Payments are not configured' });

    const group = req.group;
    const state = await getSeriesState(group);
    const { series, turnMember } = state;
    if (!turnMember) return res.status(404).json({ error: `No member found for Series ${series}.` });

    const isOwner = req.groupRole === 'owner';
    if (!isOwner && String(turnMember.user_id) !== String(req.userId)) {
      return res.status(403).json({ error: 'Only the group owner or the member whose turn it is can check this payout.' });
    }

    const latest = await Transfer.findOne({ group_id: group._id, series_number: series }).sort({ created_at: -1 });

    // 1. A transfer is already in flight or done: refresh its status from Paystack.
    if (latest && PAYOUT_STATUSES.includes(latest.status)) {
      const fresh = latest.status === 'success' ? latest : await syncTransfer(latest);
      const st = fresh?.status || latest.status;
      const message = st === 'success'
        ? `The cash-out of ₦${Number(latest.amount).toLocaleString()} was sent to ${turnMember.name}'s bank. If it is not in the account yet, give the bank a little time, then report a dispute with reference ${latest.reference}.`
        : st === 'failed'
          ? 'The cash-out failed at the bank. Check again to retry it.'
          : 'The cash-out is still processing. Please check again shortly.';
      return res.json({ status: st, reference: latest.reference, message });
    }

    // 2. Avoid hammering retries.
    if (latest && latest.status === 'failed' && Date.now() - new Date(latest.created_at).getTime() < RECHECK_COOLDOWN_MS) {
      return res.json({ status: 'failed', message: 'A retry was just attempted. Please wait a couple of minutes and check again.' });
    }

    // 3. Nothing in flight: can it be released now?
    const plan = await preparePayout(group, { requireDue: false });
    if (!plan.ok) return res.json({ status: 'blocked', code: plan.code, message: plan.message });

    // Repeated failures: only the owner may force another retry.
    const failures = await Transfer.countDocuments({ group_id: group._id, series_number: series, status: 'failed' });
    if (!isOwner && failures >= MAX_AUTO_PAYOUT_FAILURES) {
      return res.json({ status: 'blocked', code: 'too_many_failures', message: 'Automatic payout is paused after repeated failures. The group owner must release it, or you can report a dispute.' });
    }

    try {
      const transfer = await initiatePayout(group, plan);
      waitingForSettlement.delete(`${group._id}:${plan.series}`);
      return res.json({ status: transfer.status, reference: transfer.reference, message: 'Cash-out has been sent again and is being processed.' });
    } catch (err) {
      if (err.code === 'insufficient_balance') {
        await noticeSettlementWait(group, plan);
        return res.json({ status: 'waiting_settlement', message: 'Contributions are still settling with our payment partner (usually within 24 hours). The cash-out will be sent automatically.' });
      }
      throw err;
    }
  } catch (err) {
    return serverError(res, err, 'Could not check the payout.');
  }
});

// Report that a cash-out was not received.
paystackRouter.post('/disputes/:groupId', authMiddleware, requireGroupMember(req => req.params.groupId), async (req, res) => {
  try {
    const group = req.group;
    const state = await getSeriesState(group);
    const { series, turnMember } = state;
    if (!turnMember) return res.status(404).json({ error: 'No cash-out to dispute for this series.' });

    const isOwner = req.groupRole === 'owner';
    if (!isOwner && String(turnMember.user_id) !== String(req.userId)) {
      return res.status(403).json({ error: 'Only the member whose turn it is, or the group owner, can report this.' });
    }

    const open = await Dispute.findOne({ group_id: group._id, series_number: series, member_id: turnMember._id, status: 'open' });
    if (open) return res.status(409).json({ error: 'A dispute for this cash-out is already open.' });

    const latest = await Transfer.findOne({ group_id: group._id, series_number: series }).sort({ created_at: -1 });
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : '';

    const dispute = await Dispute.create({
      group_id: group._id,
      member_id: turnMember._id,
      user_id: req.userId,
      series_number: series,
      note,
      transfer_reference: latest?.reference || null,
      transfer_status: latest?.status || null,
    });

    try {
      await Activity.create({
        group_id: group._id,
        member_id: turnMember._id,
        type: 'dispute', // add to your Activity type enum if it has one
        title: `Dispute opened: ${turnMember.name} reports cash-out not received`,
        amount: latest?.amount || 0,
        status: 'pending',
        payment_method: 'bank_transfer',
        reference: `dispute-${dispute._id}`,
        meta: `Series ${series}  ·  Transfer: ${latest ? latest.status : 'none made'}`,
      });
      if (String(group.owner_id) !== String(req.userId)) {
        await Notification.create({
          user_id: group.owner_id,
          group_id: group._id,
          type: 'dispute', // add to your Notification type enum if it has one
          title: `Cash-out dispute in ${group.name}`,
          body: `${turnMember.name} reports not receiving the Series ${series} cash-out.`,
          meta: { group_id: String(group._id), series_number: series, dispute_id: String(dispute._id) },
        });
      }
    } catch (err) {
      console.error('[paystack] dispute side-effects failed:', err?.message || err);
    }

    res.status(201).json({ dispute });
  } catch (err) {
    return serverError(res, err, 'Could not lodge the dispute.');
  }
});

// Open disputes for the group's current series, so the app can show "already lodged".
paystackRouter.get('/disputes/:groupId', authMiddleware, requireGroupMember(req => req.params.groupId), async (req, res) => {
  try {
    const disputes = await Dispute.find({
      group_id: req.group._id,
      series_number: req.group.current_series,
      status: 'open',
    }).select('member_id');
    res.json({ disputes: disputes.map(d => ({ member_id: String(d.member_id) })) });
  } catch (err) {
    return serverError(res, err);
  }
});
// ============================================================
// Card checkout (legacy; DVA is the supported method)
// ============================================================

// Shared by /verify and the card webhook. The amount is NEVER trusted from
// metadata — it is recomputed from the group and compared with what was paid.
async function recordCardCharge(charge, requesterId) {
  const meta = charge.metadata || {};
  if (!isId(meta.group_id) || !isId(meta.member_id)) return null;
  const [group, member] = await Promise.all([Group.findById(meta.group_id), Member.findById(meta.member_id)]);
  if (!group || !member || String(member.group_id) !== String(group._id)) return null;

  if (requesterId && String(member.user_id) !== String(requesterId) && String(group.owner_id) !== String(requesterId)) {
    return { forbidden: true };
  }

  const expected = group.contribution_amount + contributionFee(group, member);
  if (charge.amount / 100 < expected) return { underpaid: true };

  const series = Number(meta.series_number) || group.current_series || 1;
  if (series < 1 || series > group.member_count) return null;

  const result = await recordPaidContribution({
    group_id: group._id, member_id: member._id, member_name: member.name,
    series_number: series, amount: group.contribution_amount,
    payment_method: 'card', reference: charge.reference, source: 'Paystack',
  });
  return result;
}

paystackRouter.post('/initialize', authMiddleware, requireGroupMember(req => req.body?.group_id), async (req, res) => {
  try {
    const { group_id, member_id, series_number } = req.body;
    if (!isId(group_id) || !isId(member_id)) {
      return res.status(400).json({ error: 'group_id and member_id are required' });
    }
    if (!isConfigured()) {
      return res.status(503).json({ error: 'Payments are not configured.' });
    }

    const group = req.group;
    const member = await Member.findById(member_id);
    if (!member || String(member.group_id) !== String(group_id)) return res.status(404).json({ error: 'Member not found' });
    if (req.groupRole !== 'owner' && String(member.user_id) !== String(req.userId)) {
      return res.status(403).json({ error: 'You can only pay for your own membership' });
    }

    const series = Number(series_number) || group.current_series || 1;
    if (series < 1 || series > group.member_count) return res.status(400).json({ error: 'Invalid series number' });

    // The amount always comes from the group, never from the client.
    const amount = group.contribution_amount;
    const serviceFee = contributionFee(group, member);
    const totalAmount = amount + serviceFee;
    const reference = `DASHE-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const callbackUrl = process.env.PAYSTACK_CALLBACK_URL || 'https://dashe.app/payment/callback';

    const body = await paystackPost('/transaction/initialize', {
      email: req.userEmail,
      amount: kobo(totalAmount),
      reference,
      callback_url: callbackUrl,
      metadata: {
        custom_fields: [
          { display_name: 'Group', variable_name: 'group', value: group.name },
          { display_name: 'Member', variable_name: 'member', value: member.name },
          { display_name: 'Series', variable_name: 'series', value: String(series) },
          { display_name: 'Contribution', variable_name: 'contribution', value: String(amount) },
          { display_name: 'Service Fee', variable_name: 'service_fee', value: String(serviceFee) },
          { display_name: 'Fee Payer', variable_name: 'fee_payer', value: group.fee_payer || 'Shared' },
        ],
        group_id, member_id, series_number: series,
      },
    });
    res.json({ authorization_url: body.data.authorization_url, access_code: body.data.access_code, reference, amount, service_fee: serviceFee, total: totalAmount });
  } catch (err) {
    return serverError(res, err, 'Could not start the payment.');
  }
});

// ============================================================
// Identity verification (BVN) through Paystack customer validation.
//
// Paystack validates a BVN together with a bank account that belongs to it
// (POST /customer/:code/identification, type "bank_account"). The check runs
// asynchronously: /identity/verify only starts it and marks the user 'pending'.
// The webhook (customeridentification.success | .failed) finishes the job, and
// /identity/check can finish it on demand by asking Paystack whether the
// customer is now `identified`.
//
// The raw BVN goes to Paystack only — it is never stored or logged here.
// Only a keyed hash is kept, so the same BVN cannot verify two accounts.
// ============================================================

// Marks a pending identity attempt as failed and tells the user why.
async function failIdentity(user, reason) {
  user.identity_status = 'failed';
  user.identity_pending_hash = null;
  await user.save();
  await notifyUser(user._id, 'Identity verification failed', `${reason} Check your details and try again.`);
}

// Completes a pending BVN verification once Paystack confirms the customer is
// identified. Shared by the webhook and the manual status check.
// Returns the user's resulting identity_status.
async function completeIdentityVerification(user, customerCode) {
  // The hash was stored when the attempt started; without it we cannot enforce
  // "one BVN, one account", so fail closed.
  const hash = user.identity_pending_hash;
  if (!hash) {
    console.error(`[paystack] identity success for user ${user._id} has no pending hash — not verifying`);
    await failIdentity(user, 'We could not complete your verification.');
    return user.identity_status;
  }

  const reused = await User.exists({ identity_hash: hash, _id: { $ne: user._id }, identity_status: 'verified' });
  if (reused) {
    await failIdentity(user, 'This BVN has already been used to verify another account.');
    return user.identity_status;
  }

  // Name of record for the bank-account name match: prefer the name Paystack
  // stored from the BVN check; fall back to the profile name.
  let name = user.full_name;
  if (customerCode) {
    try {
      const cust = await paystackGet(`/customer/${encodeURIComponent(customerCode)}`);
      const returned = [cust.data?.first_name, cust.data?.last_name].filter(Boolean).join(' ').trim();
      if (returned) name = returned;
    } catch (err) {
      console.error('[paystack] could not fetch customer name after validation:', err?.message || err);
    }
  }

  user.identity_type = 'bvn';
  user.identity_status = 'verified';
  user.identity_verified_at = new Date();
  user.identity_name = name;
  user.identity_hash = hash;
  user.identity_reference = customerCode || null;
  user.identity_pending_hash = null;
  try {
    await user.save();
  } catch (err) {
    if (isDuplicateKey(err)) {
      await failIdentity(user, 'This BVN has already been used to verify another account.');
      return user.identity_status;
    }
    throw err;
  }
  await notifyUser(user._id, 'Identity verified', 'Your identity has been verified. You can now make payments and cash out.');
  return user.identity_status;
}

// When Paystack already holds a validated identity for this customer (for example an
// earlier attempt whose webhook was missed), it may refuse a second validation call.
// We then only accept the submitted BVN if it agrees with the masked BVN Paystack kept.
//
// The exact shape of `identifications` is not documented, so this looks for a masked
// BVN ANYWHERE in it: an 11-character value made of digits at both ends and '*' in the
// middle (for example "200*****677"). Account numbers are 10 characters, so they are
// never mistaken for a BVN.
function extractMaskedBvns(identifications) {
  const found = [];
  const walk = value => {
    if (typeof value === 'string') {
      const text = value.trim();
      if ((text.startsWith('[') || text.startsWith('{'))) {
        try { walk(JSON.parse(text)); return; } catch { /* not JSON, fall through */ }
      }
      const m = /^(\d{1,5})\*+(\d{1,5})$/.exec(text);
      if (m && text.length === 11) found.push({ head: m[1], tail: m[2] });
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  walk(identifications);
  return found;
}

// Describes the SHAPE of a value (paths, types, lengths) without ever including
// its content, so it is safe to log while debugging.
function describeShape(value, path = 'identifications') {
  if (Array.isArray(value)) return value.flatMap((v, i) => describeShape(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => describeShape(v, `${path}.${k}`));
  }
  return [`${path}: ${value === null ? 'null' : typeof value}${typeof value === 'string' ? `(len ${value.length})` : ''}`];
}

paystackRouter.post('/identity/verify', authMiddleware, async (req, res) => {
  try {
    if (!isConfigured()) return res.status(503).json({ error: 'Verification is not configured' });

    const { bvn, account_number, bank_code } = req.body || {};
    if (!/^\d{11}$/.test(String(bvn || ''))) {
      return res.status(400).json({ error: 'A valid 11-digit BVN is required' });
    }
    if (!/^\d{10}$/.test(String(account_number || ''))) {
      return res.status(400).json({ error: 'A valid 10-digit account number is required' });
    }
    if (!/^\d{3,6}$/.test(String(bank_code || ''))) {
      return res.status(400).json({ error: 'Choose your bank' });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Never let a re-attempt downgrade an account that is already verified.
    if (user.identity_status === 'verified') {
      return res.json({ status: 'verified', identity_type: user.identity_type, message: 'Identity already verified' });
    }

    const identityHash = crypto
      .createHmac('sha256', process.env.IDENTITY_HASH_KEY || SECRET_KEY)
      .update(`bvn:${String(bvn)}`)
      .digest('hex');
    const reused = await User.exists({ identity_hash: identityHash, _id: { $ne: user._id }, identity_status: 'verified' });
    if (reused) {
      return res.status(409).json({ error: 'This BVN has already been used to verify another account.' });
    }

    const customerCode = await getOrCreatePaystackCustomer(user);
    if (!customerCode) {
      return res.status(502).json({ error: 'Could not set up your payment profile. Please try again.' });
    }

    // Already validated on Paystack's side? Don't ask it to validate again.
    let existingCustomer = null;
    try {
      existingCustomer = (await paystackGet(`/customer/${encodeURIComponent(customerCode)}`)).data;
    } catch (err) {
      console.error('[paystack] could not fetch customer before validation:', err?.message || err);
    }
    if (existingCustomer?.identified === true) {
      const submitted = String(bvn);
      const masked = extractMaskedBvns(existingCustomer.identifications);
      const confirmed = masked.some(m => submitted.startsWith(m.head) && submitted.endsWith(m.tail));

      if (!confirmed) {
        console.error(
          `[paystack] customer ${customerCode} is already identified but the BVN could not be confirmed ` +
          `(${masked.length} masked BVN(s) found). identifications shape: ${describeShape(existingCustomer.identifications).join(', ') || 'empty'}`
        );
        // Paystack returned nothing we can compare against. Outside production only,
        // accept it so local testing is not blocked by an unknown response shape.
        const unverifiable = masked.length === 0;
        if (!(unverifiable && process.env.NODE_ENV !== 'production')) {
          return res.status(409).json({
            error: masked.length > 0
              ? 'This BVN does not match the one already validated on your account. Check it and try again.'
              : 'Your account is already validated with our payment partner, but we could not confirm this BVN. Please contact support.',
          });
        }
        console.warn('[paystack] DEV ONLY: accepting an already-identified customer without a BVN match. This is refused in production.');
      }

      user.identity_type = 'bvn';
      user.identity_status = 'pending';
      user.identity_pending_hash = identityHash;
      await user.save();
      const status = await completeIdentityVerification(user, customerCode);
      return res.json({
        status,
        identity_type: 'bvn',
        message: status === 'verified' ? 'Identity verified' : 'We could not complete your verification.',
      });
    }

    try {
      await paystackPost(`/customer/${encodeURIComponent(customerCode)}/identification`, {
        country: 'NG',
        type: 'bank_account',
        account_number: String(account_number),
        bvn: String(bvn),
        bank_code: String(bank_code),
        first_name: user.full_name.split(' ')[0],
        last_name: user.full_name.split(' ').slice(1).join(' ') || user.full_name,
      });
    } catch (err) {
      const reason = err.response?.data?.message || err.message;
      if (err.response && err.response.status < 500) {
        user.identity_status = 'failed';
        user.identity_pending_hash = null;
        await user.save();
        console.error('[paystack] identity validation rejected:', reason);
        return res.status(400).json({
          error: process.env.NODE_ENV === 'production'
            ? 'Identity verification failed. Check your details and try again.'
            : `Identity verification failed: ${reason}`,
        });
      }
      console.error('[paystack] identity service unavailable:', err?.message);
      return res.status(502).json({ error: 'Verification service is unavailable. Please try again.' });
    }

    user.identity_type = 'bvn';
    user.identity_status = 'pending';
    user.identity_pending_hash = identityHash;
    user.identity_verified_at = null;
    await user.save();

    res.status(202).json({
      status: 'pending',
      identity_type: 'bvn',
      message: 'Verification in progress. We will notify you when it is done.',
    });
  } catch (err) {
    console.error('[paystack] identity verification error:', err?.response?.data?.message || err?.message);
    res.status(500).json({ error: 'Identity verification failed. Please try again.' });
  }
});

// Fallback for a missed webhook (or local testing without a tunnel): ask Paystack
// whether this user's customer is now identified and, if so, finish the verification.
paystackRouter.post('/identity/check', authMiddleware, async (req, res) => {
  try {
    if (!isConfigured()) return res.status(503).json({ error: 'Verification is not configured' });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.identity_status === 'verified') {
      return res.json({ status: 'verified', message: 'Identity verified' });
    }
    if (user.identity_status !== 'pending') {
      return res.json({ status: user.identity_status || 'unverified', message: 'No verification is in progress.' });
    }

    let customer;
    try {
      customer = (await paystackGet(`/customer/${encodeURIComponent(user.email)}`)).data;
    } catch (err) {
      console.error('[paystack] identity check could not fetch customer:', err?.response?.data?.message || err?.message);
      return res.status(502).json({ error: 'Could not reach the verification service. Please try again.' });
    }

    if (customer?.identified === true) {
      const status = await completeIdentityVerification(user, customer.customer_code);
      return res.json({
        status,
        message: status === 'verified' ? 'Identity verified' : 'We could not complete your verification.',
      });
    }

    res.json({ status: 'pending', message: 'Still waiting for confirmation. Try again in a few minutes.' });
  } catch (err) {
    return serverError(res, err, 'Could not check your verification status.');
  }
});

// The caller must own the membership (or the group) the payment is for.
paystackRouter.get('/verify/:reference', authMiddleware, async (req, res) => {
  try {
    const { reference } = req.params;
    if (!/^[A-Za-z0-9_-]{6,80}$/.test(reference)) return res.status(400).json({ error: 'Invalid reference' });
    if (!isConfigured()) return res.status(503).json({ error: 'Payments are not configured' });

    const body = await paystackGet(`/transaction/verify/${encodeURIComponent(reference)}`);
    const data = body.data;

    if (data?.status === 'success' && data.currency === 'NGN') {
      const result = await recordCardCharge(data, req.userId);
      if (result?.forbidden) return res.status(403).json({ error: 'This payment does not belong to you' });
      if (result?.underpaid) return res.json({ status: 'underpaid', message: 'The amount paid is less than the amount due.' });
      if (result?.contribution) {
        return res.json(result.created
          ? { status: 'success', contribution: result.contribution }
          : { status: 'success', contribution: result.contribution, message: 'Already recorded' });
      }
    }

    res.json({ status: data?.status || 'unknown', message: data?.gateway_response || 'Payment not successful' });
  } catch (err) {
    return serverError(res, err, 'Verification failed.');
  }
});

// ============================================================
// Webhook — ONE handler for every Paystack event.
// Register either URL in the Paystack dashboard; both behave identically.
//   https://<host>/api/payments/webhook
//   https://<host>/api/payments/dva/webhook
//
// The signature is computed over the RAW body. server.js captures it with:
//   app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
// ============================================================

function validSignature(req) {
  if (!isConfigured()) return false; // an empty key would make forged events "valid"
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body));
  const expected = Buffer.from(crypto.createHmac('sha512', SECRET_KEY).update(raw).digest('hex'));
  const given = Buffer.from(String(req.headers['x-paystack-signature'] || ''));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// Defence in depth: confirm the charge with Paystack before crediting anything.
async function confirmCharge(hook) {
  if (hook.status !== 'success' || hook.currency !== 'NGN' || !hook.reference) return null;
  if (process.env.PAYSTACK_VERIFY_CHARGES === 'false') return hook;
  try {
    const body = await paystackGet(`/transaction/verify/${encodeURIComponent(hook.reference)}`);
    const d = body.data;
    return d && d.status === 'success' && d.currency === 'NGN' ? { ...hook, amount: d.amount } : null;
  } catch (err) {
    if (err.response?.status === 404) {
      console.error(`[paystack] charge ${hook.reference} could not be verified (404) — ignored`);
      return null;
    }
    throw err; // network/5xx: let Paystack retry the webhook
  }
}

// Money that reached our balance but could not be matched to a contribution.
// It is never dropped silently: it is logged loudly and, when the group is known,
// written to the group's activity feed so someone can reconcile it.
async function flagUnallocated(reason, { reference, amount, accountNumber }, dva) {
  console.error(`[paystack] UNALLOCATED FUNDS: ${reason} — ref ${reference}, ₦${amount}, account ${accountNumber || 'unknown'}`);
  if (!dva?.group_id) return;
  try {
    if (await Activity.exists({ reference, type: 'unallocated_funds' })) return;
    await Activity.create({
      group_id: dva.group_id,
      member_id: dva.member_id,
      type: 'unallocated_funds',
      title: `₦${Number(amount).toLocaleString()} received and needs review`,
      amount,
      status: 'needs_review',
      payment_method: 'dva',
      reference,
      meta: reason,
    });
  } catch (err) {
    console.error('[paystack] could not record unallocated funds activity:', err?.message || err);
  }
}

async function handleDvaCredit(hook) {
  const charge = await confirmCharge(hook);
  if (!charge) return;

  const amount = charge.amount / 100;
  const accountNumber = hook.authorization?.receiver_bank_account_number || hook.dedicated_account?.account_number;
  const customerCode = hook.customer?.customer_code;
  const ctx = { reference: hook.reference, amount, accountNumber };
  if (!accountNumber && !customerCode) {
    await flagUnallocated('credit had no account number or customer code', ctx, null);
    return;
  }
  const filter = accountNumber ? { account_number: String(accountNumber) } : { paystack_customer_code: customerCode };

  // One Paystack account can serve several group/series expectations for the
  // same person. Match on the exact expected amount; if there is only one open
  // DVA use it. Never GUESS between several — that could credit the wrong group.
  const candidates = await DVA.find({ ...filter, status: 'active' }).sort({ created_at: 1 });
  const match = candidates.find(d => d.amount_expected === amount) || (candidates.length === 1 ? candidates[0] : null);
  if (!match) {
    const any = await DVA.findOne(filter).sort({ created_at: -1 });
    const reason = candidates.length > 1
      ? 'several open DVAs share this account and none matches the amount'
      : any ? 'payment arrived on a DVA with no open series (already funded/closed)'
        : 'no DVA found for this account';
    await flagUnallocated(reason, ctx, any);
    return;
  }

  // Atomic + idempotent: a retried webhook with the same reference is a no-op.
  const dva = await DVA.findOneAndUpdate(
    { _id: match._id, processed_references: { $ne: hook.reference } },
    { $inc: { amount_received: amount }, $push: { processed_references: hook.reference } },
    { new: true }
  );
  if (!dva) return;

  // Underpayment: keep the money on the DVA and wait for the rest.
  // Nothing is recorded as "paid" until the full amount is in.
  if (dva.amount_received < dva.amount_expected) return;

  const funded = await DVA.findOneAndUpdate({ _id: dva._id, status: 'active' }, { status: 'funded' }, { new: true });
  if (!funded) {
    await flagUnallocated('DVA was funded concurrently by another payment', ctx, dva);
    return;
  }

  const excess = dva.amount_received - dva.amount_expected;
  if (excess > 0) {
    await flagUnallocated(`overpayment of ₦${excess.toLocaleString()} beyond the expected amount`, { ...ctx, amount: excess }, dva);
  }

  const member = await Member.findById(dva.member_id);
  // The contribution is recorded WITHOUT the service fee.
  const contributionAmount = dva.contribution_amount || Math.max(0, dva.amount_expected - (dva.service_fee || 0));
  const series = dva.series_number || 1;

  const lateTransfer = await Transfer.findOne({ group_id: dva.group_id, series_number: series, status: { $in: PAYOUT_STATUSES } });

  await recordPaidContribution({
    group_id: dva.group_id,
    member_id: dva.member_id,
    member_name: member?.name,
    series_number: series,
    amount: contributionAmount,
    payment_method: 'dva',
    reference: hook.reference,
    source: `DVA ${dva.account_number}`,
    note: lateTransfer ? 'LATE — received after cash-out was initiated' : undefined,
  });
}

async function handleTransferEvent(event) {
  const data = event.data;
  const status = event.event === 'transfer.success' ? 'success' : 'failed';
  const reversed = event.event === 'transfer.reversed';
  const transfer = await Transfer.findOneAndUpdate(
    { reference: data.reference },
    { status, paystack_response: JSON.stringify(data) }
  );
  // findOneAndUpdate returns the pre-update doc: skip if this status was already applied.
  if (!transfer || transfer.status === status) return;

  if (status === 'success') {
    const group = await Group.findById(transfer.group_id);
    if (group && transfer.series_number < group.member_count) {
      // Atomic: only advances if the series hasn't already moved on.
      await Group.updateOne({ _id: group._id, current_series: transfer.series_number }, { $inc: { current_series: 1 } });
    }
  }

  // A payout that succeeded and was later reversed by Paystack: the series has already
  // advanced, so step it back (only if nothing else moved it) so the payout can be retried.
  if (status === 'failed' && transfer.status === 'success') {
    await Group.updateOne(
      { _id: transfer.group_id, current_series: transfer.series_number + 1 },
      { $inc: { current_series: -1 } }
    );
    console.error(`[paystack] transfer ${transfer.reference} was REVERSED after success — series rolled back`);
  }

  const wasReversal = reversed || (status === 'failed' && transfer.status === 'success');
  await Activity.create({
    group_id: transfer.group_id,
    member_id: transfer.member_id,
    type: 'cashout',
    title: status === 'success'
      ? `Cash-out of ₦${transfer.amount.toLocaleString()} completed`
      : wasReversal
        ? `Cash-out of ₦${transfer.amount.toLocaleString()} was reversed`
        : `Cash-out of ₦${transfer.amount.toLocaleString()} failed`,
    amount: transfer.amount,
    status,
    payment_method: 'bank_transfer',
    reference: transfer.reference,
    meta: `Series ${transfer.series_number || ''}  ·  ${status === 'success' ? 'Transfer successful' : wasReversal ? 'Transfer reversed — retry needed' : 'Transfer failed — retry needed'}`,
  });
}

// Result of a BVN validation started by POST /identity/verify.
// Only acts on users who are currently 'pending', so stale or replayed events do nothing.
async function handleIdentityEvent(event) {
  const data = event.data || {};
  const email = String(data.email || '').trim().toLowerCase();
  if (!email) return;

  const user = await User.findOne({ email });
  if (!user || user.identity_status !== 'pending') return;

  if (event.event === 'customeridentification.failed') {
    const reason = typeof data.reason === 'string' && data.reason ? `${data.reason}.` : 'We could not verify your details.';
    console.error(`[paystack] identity validation failed for user ${user._id}: ${data.reason || 'no reason given'}`);
    await failIdentity(user, reason);
    return;
  }

  await completeIdentityVerification(user, data.customer_code);
}

async function paystackWebhook(req, res) {
  try {
    if (!validSignature(req)) return res.status(401).json({ error: 'Invalid signature' });

    const event = req.body;

    if (event.event === 'dedicatedaccount.assign.success') {
      const account = event.data?.dedicated_account || event.data || {};
      const id = account.id?.toString();
      if (id && account.account_number) {
        // Only refresh account details; never change status here.
        await DVA.updateMany({ paystack_dva_reference: id }, { account_number: account.account_number, account_name: account.account_name });
      }
    }

    if (event.event === 'charge.success') {
      if (event.data?.channel === 'dedicated_nuban') {
        await handleDvaCredit(event.data);
      } else {
        const charge = await confirmCharge(event.data || {});
        if (charge) await recordCardCharge(charge, null);
      }
    }

    if (['transfer.success', 'transfer.failed', 'transfer.reversed'].includes(event.event)) {
      await handleTransferEvent(event);
    }

    if (['customeridentification.success', 'customeridentification.failed'].includes(event.event)) {
      await handleIdentityEvent(event);
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[paystack] webhook error:', err?.message || err);
    res.status(500).json({ error: 'Webhook processing failed' }); // Paystack will retry
  }
}

paystackRouter.post('/webhook', paystackWebhook);
paystackRouter.post('/dva/webhook', paystackWebhook);

// ============================================================
// DVA — Dedicated Virtual Account creation
// The amount is ALWAYS computed here from the group; any amount sent by the
// client is ignored.
// ============================================================

paystackRouter.post('/dva/create', authMiddleware, requireGroupMember(req => req.body?.group_id), async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ error: 'Payments are not configured.' });
    }

    const { group_id, member_id, series_number } = req.body;
    if (!isId(group_id) || !isId(member_id)) {
      return res.status(400).json({ error: 'group_id and member_id are required' });
    }

    const group = req.group;
    const targetSeries = Number(series_number) || group.current_series || 1;
    if (!Number.isInteger(targetSeries) || targetSeries < (group.current_series || 1) || targetSeries > group.member_count) {
      return res.status(400).json({ error: 'Invalid series number' });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Members must verify their identity before they can pay in.
    if (identityRequired() && user.identity_status !== 'verified') {
      return res.status(403).json({ error: 'Verify your identity (BVN) before making payments.', code: 'identity_unverified' });
    }

    const member = await Member.findById(member_id);
    if (!member || String(member.group_id) !== String(group_id)) return res.status(404).json({ error: 'Member not found' });

    // A DVA is a personal collection account — only the member it belongs to
    // (or the group owner, generating it on someone's behalf) may create it.
    if (req.groupRole !== 'owner' && String(member.user_id) !== String(req.userId)) {
      return res.status(403).json({ error: 'You can only generate a DVA for your own membership' });
    }

    const alreadyPaid = await Contribution.findOne({ group_id, member_id, series_number: targetSeries, status: { $in: ['pending', 'completed'] } });
    if (alreadyPaid) {
      return res.status(409).json({ error: `Series ${targetSeries} has already been paid` });
    }

    const payoutMade = await Transfer.findOne({ group_id, series_number: targetSeries, status: { $in: PAYOUT_STATUSES } });
    if (payoutMade) {
      return res.status(409).json({ error: `Series ${targetSeries} has already been cashed out and is closed for payments` });
    }

    // Check for existing active DVA for this group + member + series
    const existing = await DVA.findOne({ group_id, member_id, series_number: targetSeries, status: 'active' });
    if (existing) {
      return res.json({ dva: existing, message: 'DVA already exists for this series' });
    }

    const contribution_amount = group.contribution_amount;
    const service_fee = contributionFee(group, member);
    const amount_expected = contribution_amount + service_fee;

    // Paystack issues one dedicated account per customer, so reuse this user's
    // existing account instead of asking Paystack for another one.
    let account;
    const prior = await DVA.findOne({ user_id: req.userId, paystack_customer_code: { $ne: null }, account_number: { $ne: null } }).sort({ created_at: -1 });

    if (prior) {
      account = {
        customerCode: prior.paystack_customer_code,
        account_name: prior.account_name,
        account_number: prior.account_number,
        bank: prior.bank,
        bank_code: prior.bank_code,
        dva_reference: prior.paystack_dva_reference,
      };
    } else {
      // Step 1: Create or find a Paystack customer
      const customerCode = await getOrCreatePaystackCustomer(user);

      if (!customerCode) {
        return res.status(502).json({ error: 'Could not set up your payment profile. Please try again.' });
      }

      // Step 2: Create a Dedicated Virtual Account
      let dvaData = null;
      try {
        const created = await paystackPost('/dedicated_account', {
          customer: customerCode,
          preferred_bank: 'wema-bank',
          subaccount: null,
          first_name: user.full_name.split(' ')[0] || 'Dashe',
          last_name: user.full_name.split(' ').slice(1).join(' ') || 'User',
          phone: user.phone || '',
        });
        dvaData = created.data;
      } catch (dvaErr) {
        console.error('[paystack] dedicated_account failed:', dvaErr.response?.data || dvaErr.message);
        return res.status(502).json({ error: 'Could not generate your virtual account. Please try again.' });
      }

      account = {
        customerCode,
        account_name: dvaData.account_name || user.full_name,
        account_number: dvaData.account_number,
        bank: dvaData.bank?.name || 'Wema Bank',
        bank_code: '044',
        dva_reference: dvaData.id?.toString() || null,
      };
    }

    const dva = await DVA.create({
      user_id: req.userId,
      group_id,
      member_id,
      account_name: account.account_name,
      account_number: account.account_number,
      bank: account.bank,
      bank_code: account.bank_code,
      paystack_customer_code: account.customerCode,
      paystack_dva_reference: account.dva_reference,
      series_number: targetSeries,
      amount_expected,
      contribution_amount,
      service_fee,
      amount_received: 0,
      status: 'active',
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    // NOT a contribution: just a log line that an account was issued.
    // It uses its own type ('dva_created') so the app never shows it as a
    // contribution or a payment. Real contributions are recorded only by the
    // webhook (recordPaidContribution) once Paystack confirms the money arrived.
    // If your Activity schema has a `type` enum, add 'dva_created' to it.
    // Best-effort: a logging problem must not fail an account that already exists.
    try {
      await Activity.create({
        group_id,
        member_id,
        type: 'dva_created',
        title: `Virtual account generated for ${member.name}`,
        amount: amount_expected,
        status: 'pending',
        payment_method: 'dva',
        reference: account.account_number,
        meta: `Awaiting payment  ·  Account: ${account.account_number}  ·  ${account.bank}  ·  Series ${targetSeries}`,
      });
    } catch (err) {
      console.error('[paystack] could not log DVA creation activity:', err?.message || err);
    }

    res.status(201).json({ dva });
  } catch (err) {
    return serverError(res, err, 'Could not generate your virtual account.');
  }
});

// Get all DVAs for the current user (already scoped to req.userId)
paystackRouter.get('/dva', authMiddleware, async (req, res) => {
  try {
    const dvas = await DVA.find({ user_id: req.userId, status: 'active' }).sort({ created_at: -1 });
    res.json({ dvas });
  } catch (err) {
    return serverError(res, err);
  }
});

// Manual "I've paid" check: looks for this user's missed DVA credits on Paystack and
// records them. Works without a webhook tunnel. Only touches the caller's own DVAs.
paystackRouter.post('/dva/sync', authMiddleware, async (req, res) => {
  try {
    if (!isConfigured()) return res.status(503).json({ error: 'Payments are not configured' });
    const result = await reconcileDvaCredits({ userId: req.userId });
    res.json({ status: 'ok', ...result });
  } catch (err) {
    return serverError(res, err, 'Could not check for your payment.');
  }
});

// Get the caller's DVA for a specific group + series — requires group membership.
// Looked up by the caller's membership (member_id), not by whoever created the DVA.
// "No DVA yet" is a normal state, so it returns 200 { dva: null } instead of a 404.
paystackRouter.get('/dva/group/:groupId', authMiddleware, requireGroupMember(req => req.params.groupId), async (req, res) => {
  try {
    const { series_number } = req.query;

    const member = await Member.findOne({
      group_id: req.params.groupId,
      user_id: req.userId,
      status: { $nin: ['exited', 'exit_pending_replacement'] },
    });
    if (!member) return res.json({ dva: null });

    const filter = { group_id: req.params.groupId, member_id: member._id, status: 'active' };
    if (series_number) {
      const n = Number(series_number);
      if (!Number.isInteger(n) || n < 1) return res.status(400).json({ error: 'Invalid series number' });
      filter.series_number = n;
    }

    const dva = await DVA.findOne(filter).sort({ created_at: -1 });
    res.json({ dva: dva || null });
  } catch (err) {
    return serverError(res, err);
  }
});

// ============================================================
// Transfer recipient — the user's own bank account for receiving cash-outs
// ============================================================

const nameTokens = s => String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(t => t.length > 1);
function namesMatch(referenceName, accountName) {
  const reference = new Set(nameTokens(referenceName));
  const shared = nameTokens(accountName).filter(t => reference.has(t)).length;
  return shared >= Math.min(2, reference.size);
}

paystackRouter.post('/recipient/create', authMiddleware, async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ error: 'Payments are not configured' });
    }

    const { account_number, bank_code, bank_name } = req.body || {};
    if (!/^\d{10}$/.test(String(account_number || '')) || !/^\d{3,6}$/.test(String(bank_code || ''))) {
      return res.status(400).json({ error: 'A valid 10-digit account number and bank are required' });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Check if recipient already exists for this user + account
    const existing = await TransferRecipient.findOne({ user_id: req.userId, account_number: String(account_number), bank_code: String(bank_code) });
    if (existing && existing.paystack_recipient_code) {
      return res.json({ recipient: existing, message: 'Recipient already exists' });
    }

    // Payout accounts must belong to the user: the resolved bank account name has
    // to match the name of record (on by default in production). When identity is
    // verified that is the name from the BVN lookup, not the editable profile name.
    const enforceName = process.env.REQUIRE_ACCOUNT_NAME_MATCH
      ? process.env.REQUIRE_ACCOUNT_NAME_MATCH === 'true'
      : process.env.NODE_ENV === 'production';
    const referenceName = user.identity_status === 'verified' && user.identity_name ? user.identity_name : user.full_name;
    let accountName = referenceName;
    if (enforceName) {
      try {
        const resolved = await paystackGet(`/bank/resolve?account_number=${encodeURIComponent(account_number)}&bank_code=${encodeURIComponent(bank_code)}`);
        accountName = resolved.data?.account_name || '';
      } catch {
        return res.status(400).json({ error: 'We could not verify that bank account. Check the details and try again.' });
      }
      if (!accountName || !namesMatch(referenceName, accountName)) {
        return res.status(400).json({ error: 'The bank account name does not match the name on your verified profile.' });
      }
    }

    const body = await paystackPost('/transferrecipient', {
      type: 'nuban',
      name: accountName,
      account_number: String(account_number),
      bank_code: String(bank_code),
      currency: 'NGN',
    });
    const recipientCode = body.data.recipient_code;

    let recipient;
    if (existing) {
      existing.paystack_recipient_code = recipientCode;
      existing.is_verified = true;
      existing.bank_name = bank_name || existing.bank_name;
      await existing.save();
      recipient = existing;
    } else {
      recipient = await TransferRecipient.create({
        user_id: req.userId,
        name: accountName,
        account_number: String(account_number),
        bank_code: String(bank_code),
        bank_name: typeof bank_name === 'string' ? bank_name.slice(0, 100) : '',
        paystack_recipient_code: recipientCode,
        is_verified: true,
      });
    }

    res.status(201).json({ recipient });
  } catch (err) {
    return serverError(res, err, 'Could not save your bank account.');
  }
});

// Get user's transfer recipients (already scoped to req.userId)
paystackRouter.get('/recipients', authMiddleware, async (req, res) => {
  try {
    const recipients = await TransferRecipient.find({ user_id: req.userId }).sort({ created_at: -1 });
    res.json({ recipients });
  } catch (err) {
    return serverError(res, err);
  }
});

// ============================================================
// Cash-out
// ============================================================

// Who has paid, who hasn't, and what the cash-out would be — visible to group members.
paystackRouter.get('/payout-status/:groupId', authMiddleware, requireGroupMember(req => req.params.groupId), async (req, res) => {
  try {
    const group = req.group;
    const state = await getSeriesState(group);
    res.json({
      series: state.series,
      member_count: state.members.length,
      paid_count: state.paid.length,
      expected: grossPool(group),
      collected: state.collected,
      fee: payoutFee(group, state.collected),
      net: payoutNet(group, state.collected),
      turn_member: state.turnMember ? { id: String(state.turnMember._id), name: state.turnMember.name } : null,
      turn_member_paid: state.turnPaid,
      unpaid: state.unpaid.map(m => ({ member_id: String(m._id), name: m.name })),
    });
  } catch (err) {
    return serverError(res, err);
  }
});

// Owner releases the cash-out for the current series. The server decides the
// recipient and the amount; nothing about either is taken from the request.
async function releasePayout(req, res) {
  try {
    if (!isConfigured()) return res.status(503).json({ error: 'Payments are not configured' });

    const group = req.group;
    const plan = await preparePayout(group, { requireDue: false });
    if (!plan.ok) {
      if (plan.code === 'already_paid') return res.json({ transfer: plan.existing, message: plan.message });
      return res.status(409).json({
        error: plan.message,
        code: plan.code,
        unpaid: plan.state.unpaid.map(m => ({ member_id: String(m._id), name: m.name })),
      });
    }

    const transfer = await initiatePayout(group, plan);
    waitingForSettlement.delete(`${group._id}:${plan.series}`);
    res.status(201).json({ transfer, message: 'Cash-out initiated successfully' });
  } catch (err) {
    if (err.code === 'insufficient_balance') return res.status(409).json({ error: err.message, code: err.code });
    return serverError(res, err, 'Cash-out failed.');
  }
}

paystackRouter.post('/auto-payout/:groupId', authMiddleware, requireGroupMember(req => req.params.groupId), requireGroupOwner, releasePayout);
// Legacy manual route: same rules (turn member only, server-computed amount).
paystackRouter.post('/transfer/initiate', authMiddleware, requireGroupMember(req => req.body?.group_id), requireGroupOwner, releasePayout);

// Get transfers for a user (already scoped to req.userId)
paystackRouter.get('/transfers', authMiddleware, async (req, res) => {
  try {
    const transfers = await Transfer.find({ user_id: req.userId }).sort({ created_at: -1 });
    res.json({ transfers });
  } catch (err) {
    return serverError(res, err);
  }
});