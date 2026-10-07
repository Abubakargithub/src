import { Router } from 'express';
import axios from 'axios';
import { Contribution } from '../models/Contribution.js';
import { Member } from '../models/Member.js';
import { Activity } from '../models/Activity.js';
import { Group } from '../models/Group.js';
import { User } from '../models/User.js';
import { DVA } from '../models/DVA.js';
import { TransferRecipient } from '../models/TransferRecipient.js';
import { Transfer } from '../models/Transfer.js';
import { authMiddleware } from '../middleware/auth.js';

export const paystackRouter = Router();

const PAYSTACK_BASE = 'https://api.paystack.co';
const SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';

function paystackHeaders() {
  return {
    Authorization: `Bearer ${SECRET_KEY}`,
    'Content-Type': 'application/json',
  };
}

function isConfigured() {
  return SECRET_KEY && !SECRET_KEY.startsWith('sk_test_xxx');
}

paystackRouter.post('/initialize', authMiddleware, async (req, res) => {
  try {
    const { group_id, member_id, member_name, series_number, amount, payment_method } = req.body;
    if (!group_id || !member_id || !amount) {
      return res.status(400).json({ error: 'group_id, member_id, and amount are required' });
    }
    if (!SECRET_KEY || SECRET_KEY.startsWith('sk_test_xxx')) {
      return res.status(503).json({ error: 'Paystack is not configured. Add your Paystack secret key to the server .env file.' });
    }

    const group = await Group.findById(group_id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const member = await Member.findById(member_id);
    if (!member) return res.status(404).json({ error: 'Member not found' });

    const totalAmount = amount + 50;
    const reference = `DASHE-${Date.now().toString(36).toUpperCase()}`;
    const callbackUrl = process.env.PAYSTACK_CALLBACK_URL || 'https://dashe.app/payment/callback';

    const payload = {
      email: req.userEmail,
      amount: totalAmount * 100,
      reference,
      callback_url: callbackUrl,
      metadata: {
        custom_fields: [
          { display_name: 'Group', variable_name: 'group', value: group.name },
          { display_name: 'Member', variable_name: 'member', value: member_name || member.name },
          { display_name: 'Series', variable_name: 'series', value: String(series_number || 1) },
          { display_name: 'Contribution', variable_name: 'contribution', value: String(amount) },
          { display_name: 'Service Fee', variable_name: 'service_fee', value: '50' },
        ],
        group_id, member_id, member_name: member_name || member.name,
        series_number: series_number || 1, amount, payment_method: payment_method || 'card',
      },
    };

    const response = await axios.post(`${PAYSTACK_BASE}/transaction/initialize`, payload, { headers: paystackHeaders() });
    res.json({ authorization_url: response.data.data.authorization_url, access_code: response.data.data.access_code, reference });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    res.status(500).json({ error: `Paystack initialization failed: ${msg}` });
  }
});

paystackRouter.get('/verify/:reference', authMiddleware, async (req, res) => {
  try {
    const { reference } = req.params;
    if (!SECRET_KEY || SECRET_KEY.startsWith('sk_test_xxx')) {
      return res.status(503).json({ error: 'Paystack is not configured' });
    }

    const response = await axios.get(`${PAYSTACK_BASE}/transaction/verify/${reference}`, { headers: paystackHeaders() });
    const data = response.data.data;

    if (data.status === 'success') {
      const meta = data.metadata || {};
      const { group_id, member_id, member_name, series_number, amount, payment_method } = meta;

      if (group_id && member_id && amount) {
        const existing = await Contribution.findOne({ reference });
        if (!existing) {
          const contribution = await Contribution.create({
            group_id, member_id, member_name: member_name || 'Unknown',
            series_number: series_number || 1, amount,
            status: 'completed', payment_method: payment_method || 'card',
            due_date: new Date().toISOString().slice(0, 10),
            paid_at: new Date(), reference, paystack_reference: data.reference,
          });

          await Member.findByIdAndUpdate(member_id, { $inc: { paid_count: 1 }, status: 'active' });

          await Activity.create({
            group_id, member_id,
            type: 'contribution',
            title: `${member_name || 'Member'} contributed ₦${amount.toLocaleString()}`,
            amount, status: 'completed',
            payment_method: payment_method || 'card', reference,
            meta: `Series ${series_number || 1}  ·  ${(payment_method || 'card').toUpperCase()}  ·  Paystack`,
          });

          return res.json({ status: 'success', contribution });
        }
        return res.json({ status: 'success', contribution: existing, message: 'Already recorded' });
      }
    }

    res.json({ status: data.status, message: data.gateway_response || 'Payment not successful' });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    res.status(500).json({ error: `Verification failed: ${msg}` });
  }
});

paystackRouter.post('/webhook', async (req, res) => {
  try {
    const event = req.body;
    const crypto = await import('crypto');
    const hash = crypto.createHmac('sha512', SECRET_KEY).update(JSON.stringify(req.body)).digest('hex');
    if (hash !== req.headers['x-paystack-signature']) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    if (event.event === 'charge.success') {
      const data = event.data;
      const meta = data.metadata || {};
      const { group_id, member_id, member_name, series_number, amount, payment_method } = meta;

      if (group_id && member_id && amount) {
        const existing = await Contribution.findOne({ reference: data.reference });
        if (!existing) {
          await Contribution.create({
            group_id, member_id, member_name: member_name || 'Unknown',
            series_number: series_number || 1, amount,
            status: 'completed', payment_method: payment_method || 'card',
            due_date: new Date().toISOString().slice(0, 10),
            paid_at: new Date(), reference: data.reference, paystack_reference: data.reference,
          });
          await Member.findByIdAndUpdate(member_id, { $inc: { paid_count: 1 }, status: 'active' });
          await Activity.create({
            group_id, member_id, type: 'contribution',
            title: `${member_name || 'Member'} contributed ₦${amount.toLocaleString()}`,
            amount, status: 'completed', payment_method: payment_method || 'card',
            reference: data.reference,
            meta: `Series ${series_number || 1}  ·  ${(payment_method || 'card').toUpperCase()}  ·  Paystack webhook`,
          });
        }
      }
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// DVA — Dedicated Virtual Account creation
// ============================================================

paystackRouter.post('/dva/create', authMiddleware, async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ error: 'Paystack is not configured. Add your Paystack secret key to the server .env file.' });
    }

    const { group_id, member_id, series_number, amount_expected } = req.body;
    if (!group_id || !member_id || !amount_expected) {
      return res.status(400).json({ error: 'group_id, member_id, and amount_expected are required' });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const member = await Member.findById(member_id);
    if (!member) return res.status(404).json({ error: 'Member not found' });

    // Check for existing active DVA for this group + member + series
    const existing = await DVA.findOne({ group_id, member_id, series_number, status: 'active' });
    if (existing) {
      return res.json({ dva: existing, message: 'DVA already exists for this series' });
    }

    // Step 1: Create or find a Paystack customer
    let customerCode = null;
    try {
      const custResp = await axios.post(`${PAYSTACK_BASE}/customer`, {
        email: user.email,
        first_name: user.full_name.split(' ')[0] || 'Dashe',
        last_name: user.full_name.split(' ').slice(1).join(' ') || 'User',
        phone: user.phone || '',
        metadata: {
          user_id: req.userId,
          group_id,
          member_id,
        },
      }, { headers: paystackHeaders() });
      customerCode = custResp.data.data.customer_code;
    } catch (custErr) {
      // Customer may already exist — try to find by email
      const listResp = await axios.get(`${PAYSTACK_BASE}/customer?email=${encodeURIComponent(user.email)}`, { headers: paystackHeaders() });
      if (listResp.data.data && listResp.data.data.length > 0) {
        customerCode = listResp.data.data[0].customer_code;
      }
    }

    if (!customerCode) {
      return res.status(500).json({ error: 'Failed to create Paystack customer' });
    }

    // Step 2: Create a Dedicated Virtual Account
    let dvaData = null;
    try {
      const dvaResp = await axios.post(`${PAYSTACK_BASE}/dedicated_account`, {
        customer: customerCode,
        preferred_bank: 'wema-bank',
        subaccount: null,
        first_name: user.full_name.split(' ')[0] || 'Dashe',
        last_name: user.full_name.split(' ').slice(1).join(' ') || 'User',
        phone: user.phone || '',
      }, { headers: paystackHeaders() });
      dvaData = dvaResp.data.data;
    } catch (dvaErr) {
      return res.status(500).json({ error: `DVA creation failed: ${dvaErr.response?.data?.message || dvaErr.message}` });
    }

    const dva = await DVA.create({
      user_id: req.userId,
      group_id,
      member_id,
      account_name: dvaData.account_name || user.full_name,
      account_number: dvaData.account_number,
      bank: dvaData.bank?.name || 'Wema Bank',
      bank_code: '044',
      paystack_customer_code: customerCode,
      paystack_dva_reference: dvaData.id?.toString() || null,
      series_number: series_number || null,
      amount_expected,
      amount_received: 0,
      status: 'active',
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    await Activity.create({
      group_id,
      member_id,
      type: 'contribution',
      title: `DVA generated for ${member.name}`,
      amount: amount_expected,
      status: 'pending',
      payment_method: 'dva',
      reference: dvaData.account_number,
      meta: `Account: ${dvaData.account_number}  ·  ${dvaData.bank?.name || 'Wema Bank'}  ·  Series ${series_number || ''}`,
    });

    res.status(201).json({ dva });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    res.status(500).json({ error: `DVA creation failed: ${msg}` });
  }
});

// Get all DVAs for the current user
paystackRouter.get('/dva', authMiddleware, async (req, res) => {
  try {
    const dvas = await DVA.find({ user_id: req.userId, status: 'active' }).sort({ created_at: -1 });
    res.json({ dvas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get DVA for a specific group + series
paystackRouter.get('/dva/group/:groupId', authMiddleware, async (req, res) => {
  try {
    const { series_number } = req.query;
    const filter = { user_id: req.userId, group_id: req.params.groupId, status: 'active' };
    if (series_number) filter.series_number = Number(series_number);
    const dva = await DVA.findOne(filter).sort({ created_at: -1 });
    if (!dva) return res.status(404).json({ error: 'No DVA found' });
    res.json({ dva });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Transfer Recipient — for payouts to user bank accounts
// ============================================================

paystackRouter.post('/recipient/create', authMiddleware, async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ error: 'Paystack is not configured' });
    }

    const { account_number, bank_code, bank_name } = req.body;
    if (!account_number || !bank_code) {
      return res.status(400).json({ error: 'account_number and bank_code are required' });
    }

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Check if recipient already exists for this user + account
    const existing = await TransferRecipient.findOne({ user_id: req.userId, account_number, bank_code });
    if (existing && existing.paystack_recipient_code) {
      return res.json({ recipient: existing, message: 'Recipient already exists' });
    }

    // Create transfer recipient in Paystack
    const payload = {
      type: 'nuban',
      name: user.full_name,
      account_number,
      bank_code,
      currency: 'NGN',
    };

    const response = await axios.post(`${PAYSTACK_BASE}/transferrecipient`, payload, { headers: paystackHeaders() });
    const recipientCode = response.data.data.recipient_code;

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
        name: user.full_name,
        account_number,
        bank_code,
        bank_name: bank_name || '',
        paystack_recipient_code: recipientCode,
        is_verified: true,
      });
    }

    res.status(201).json({ recipient });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    res.status(500).json({ error: `Recipient creation failed: ${msg}` });
  }
});

// Get user's transfer recipients
paystackRouter.get('/recipients', authMiddleware, async (req, res) => {
  try {
    const recipients = await TransferRecipient.find({ user_id: req.userId }).sort({ created_at: -1 });
    res.json({ recipients });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Transfer — initiate payout to user's bank account
// ============================================================

paystackRouter.post('/transfer/initiate', authMiddleware, async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ error: 'Paystack is not configured' });
    }

    const { group_id, member_id, amount, series_number, reason } = req.body;
    if (!group_id || !member_id || !amount) {
      return res.status(400).json({ error: 'group_id, member_id, and amount are required' });
    }

    // Find the user's transfer recipient (payout bank account)
    const recipient = await TransferRecipient.findOne({ user_id: req.userId, is_verified: true });
    if (!recipient || !recipient.paystack_recipient_code) {
      return res.status(400).json({ error: 'No verified bank account found. Add a bank account to receive payouts.' });
    }

    const reference = `DASHE-PAYOUT-${Date.now().toString(36).toUpperCase()}`;

    // Initiate transfer via Paystack
    const payload = {
      source: 'balance',
      amount: amount * 100,
      recipient: recipient.paystack_recipient_code,
      reason: reason || 'Dashe cash-out payout',
      reference,
    };

    const response = await axios.post(`${PAYSTACK_BASE}/transfer`, payload, { headers: paystackHeaders() });
    const transferData = response.data.data;

    const transfer = await Transfer.create({
      group_id,
      member_id,
      user_id: req.userId,
      recipient_code: recipient.paystack_recipient_code,
      amount,
      reason: reason || 'Dashe cash-out payout',
      reference,
      paystack_transfer_code: transferData.transfer_code || transferData.code,
      status: transferData.status || 'pending',
      series_number: series_number || null,
      paystack_response: JSON.stringify(transferData),
    });

    await Activity.create({
      group_id,
      member_id,
      type: 'cashout',
      title: `Cash-out of ₦${amount.toLocaleString()} initiated`,
      amount,
      status: transferData.status || 'pending',
      payment_method: 'bank_transfer',
      reference,
      meta: `Series ${series_number || ''}  ·  Transfer to ${recipient.bank_name} ${recipient.account_number}`,
    });

    res.status(201).json({ transfer });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    res.status(500).json({ error: `Transfer failed: ${msg}` });
  }
});

// Get transfers for a user
paystackRouter.get('/transfers', authMiddleware, async (req, res) => {
  try {
    const transfers = await Transfer.find({ user_id: req.userId }).sort({ created_at: -1 });
    res.json({ transfers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Auto-payout — when a member's turn arrives, automatically
// transfer the pooled funds to their bank account
// ============================================================

paystackRouter.post('/auto-payout/:groupId', authMiddleware, async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ error: 'Paystack is not configured' });
    }

    const group = await Group.findById(req.params.groupId);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    // Find the member whose turn it is (position === current_series)
    const member = await Member.findOne({ group_id: group._id, position: group.current_series });
    if (!member) return res.status(404).json({ error: 'No member found for current series' });

    // Check if payout already happened for this series
    const existingPayout = await Transfer.findOne({ group_id: group._id, series_number: group.current_series, status: { $in: ['success', 'pending'] } });
    if (existingPayout) {
      return res.json({ transfer: existingPayout, message: 'Payout already initiated for this series' });
    }

    // Find the member's user account and their bank recipient
    const memberUserId = member.user_id;
    if (!memberUserId) {
      return res.status(400).json({ error: 'Member has no linked user account. Manual payout required.' });
    }

    const recipient = await TransferRecipient.findOne({ user_id: memberUserId, is_verified: true });
    if (!recipient || !recipient.paystack_recipient_code) {
      return res.status(400).json({ error: 'Member has no verified bank account for payout.' });
    }

    const payoutAmount = group.contribution_amount * group.member_count;
    const reference = `DASHE-AUTO-${group._id}-${group.current_series}-${Date.now().toString(36).toUpperCase()}`;

    const payload = {
      source: 'balance',
      amount: payoutAmount * 100,
      recipient: recipient.paystack_recipient_code,
      reason: `Dashe cash-out — ${group.name} — Series ${group.current_series}`,
      reference,
    };

    const response = await axios.post(`${PAYSTACK_BASE}/transfer`, payload, { headers: paystackHeaders() });
    const transferData = response.data.data;

    const transfer = await Transfer.create({
      group_id: group._id,
      member_id: member._id,
      user_id: memberUserId,
      recipient_code: recipient.paystack_recipient_code,
      amount: payoutAmount,
      reason: `Dashe cash-out — ${group.name} — Series ${group.current_series}`,
      reference,
      paystack_transfer_code: transferData.transfer_code || transferData.code,
      status: transferData.status || 'pending',
      series_number: group.current_series,
      paystack_response: JSON.stringify(transferData),
    });

    await Activity.create({
      group_id: group._id,
      member_id: member._id,
      type: 'cashout',
      title: `${member.name} received ₦${payoutAmount.toLocaleString()} cash-out`,
      amount: payoutAmount,
      status: 'completed',
      payment_method: 'bank_transfer',
      reference,
      meta: `Series ${group.current_series}  ·  Auto-payout to ${recipient.bank_name} ${recipient.account_number}`,
    });

    // Advance the series
    if (group.current_series < group.member_count) {
      group.current_series += 1;
      await group.save();
    }

    res.json({ transfer, group, message: 'Auto-payout initiated successfully' });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    res.status(500).json({ error: `Auto-payout failed: ${msg}` });
  }
});

// Webhook handler for DVA credit notifications and transfer status updates
paystackRouter.post('/dva/webhook', async (req, res) => {
  try {
    const event = req.body;
    const crypto = await import('crypto');
    const hash = crypto.createHmac('sha512', SECRET_KEY).update(JSON.stringify(req.body)).digest('hex');
    if (hash !== req.headers['x-paystack-signature']) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    if (event.event === 'dedicatedaccount.assign.success') {
      // DVA was successfully assigned to a customer
      const data = event.data;
      await DVA.findOneAndUpdate(
        { paystack_dva_reference: data.id?.toString() },
        { status: 'active', account_number: data.account_number, account_name: data.account_name }
      );
    }

    if (event.event === 'charge.success' && event.data?.channel === 'dedicated_nuban') {
      // Money was paid into a DVA
      const data = event.data;
      const customerCode = data.customer?.customer_code;
      const amount = data.amount / 100;

      // Find the DVA by customer code
      const dva = await DVA.findOne({ paystack_customer_code: customerCode, status: 'active' });
      if (dva) {
        dva.amount_received += amount;
        if (dva.amount_received >= dva.amount_expected) {
          dva.status = 'funded';
        }
        await dva.save();

        // Record the contribution
        const existing = await Contribution.findOne({ reference: data.reference });
        if (!existing && dva.group_id && dva.member_id) {
          const member = await Member.findById(dva.member_id);
          await Contribution.create({
            group_id: dva.group_id,
            member_id: dva.member_id,
            member_name: member?.name || 'Unknown',
            series_number: dva.series_number || 1,
            amount,
            status: 'completed',
            payment_method: 'dva',
            due_date: new Date().toISOString().slice(0, 10),
            paid_at: new Date(),
            reference: data.reference,
            paystack_reference: data.reference,
          });

          await Member.findByIdAndUpdate(dva.member_id, { $inc: { paid_count: 1 }, status: 'active' });

          await Activity.create({
            group_id: dva.group_id,
            member_id: dva.member_id,
            type: 'contribution',
            title: `${member?.name || 'Member'} contributed ₦${amount.toLocaleString()} via DVA`,
            amount,
            status: 'completed',
            payment_method: 'dva',
            reference: data.reference,
            meta: `DVA: ${dva.account_number}  ·  Series ${dva.series_number || ''}`,
          });
        }
      }
    }

    if (event.event === 'transfer.success' || event.event === 'transfer.failed') {
      const data = event.data;
      const status = event.event === 'transfer.success' ? 'success' : 'failed';
      const transfer = await Transfer.findOneAndUpdate(
        { reference: data.reference },
        { status, paystack_response: JSON.stringify(data) }
      );
      if (transfer) {
        await Activity.create({
          group_id: transfer.group_id,
          member_id: transfer.member_id,
          type: 'cashout',
          title: status === 'success'
            ? `Cash-out of ₦${transfer.amount.toLocaleString()} completed`
            : `Cash-out of ₦${transfer.amount.toLocaleString()} failed`,
          amount: transfer.amount,
          status,
          payment_method: 'bank_transfer',
          reference: transfer.reference,
          meta: `Series ${transfer.series_number || ''}  ·  ${status === 'success' ? 'Transfer successful' : 'Transfer failed — retry needed'}`,
        });
      }
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
