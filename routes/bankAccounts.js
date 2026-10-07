import { Router } from 'express';
import { BankAccount } from '../models/BankAccount.js';
import { authMiddleware } from '../middleware/auth.js';
import { isObjectId } from '../middleware/groupAccess.js';

export const bankAccountsRouter = Router();

bankAccountsRouter.use(authMiddleware);

// NOTE: these records are the user's saved accounts for display only. Cash-outs are
// paid to the verified TransferRecipient created through POST /api/payments/recipient/create
// (bank name checked against the verified identity, plus a cooldown). Nothing saved here
// can ever redirect a payout.

const MAX_ACCOUNTS = 5;
const str = v => (typeof v === 'string' ? v.trim() : '');

function serverError(res, err) {
  console.error('[bank-accounts]', err);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

bankAccountsRouter.get('/', async (req, res) => {
  try {
    const accounts = await BankAccount.find({ user_id: req.userId }).sort({ created_at: -1 });
    res.json({ bank_accounts: accounts });
  } catch (err) {
    serverError(res, err);
  }
});

bankAccountsRouter.post('/', async (req, res) => {
  try {
    const bank_name = str(req.body?.bank_name);
    const account_name = str(req.body?.account_name);
    const account_number = str(req.body?.account_number);
    const bank_code = req.body?.bank_code ? str(req.body.bank_code) : null;
    const is_default = req.body?.is_default === true;

    if (!bank_name || !account_name || !account_number) {
      return res.status(400).json({ error: 'bank_name, account_name, and account_number are required' });
    }
    if (bank_name.length > 100 || account_name.length > 120) {
      return res.status(400).json({ error: 'Bank name or account name is too long' });
    }
    if (!/^\d{10}$/.test(account_number)) {
      return res.status(400).json({ error: 'Account number must be 10 digits' });
    }
    if (bank_code && !/^\d{3,6}$/.test(bank_code)) {
      return res.status(400).json({ error: 'Invalid bank code' });
    }

    const [count, duplicate] = await Promise.all([
      BankAccount.countDocuments({ user_id: req.userId }),
      BankAccount.exists({ user_id: req.userId, account_number, bank_name }),
    ]);
    if (count >= MAX_ACCOUNTS) {
      return res.status(400).json({ error: `You can save up to ${MAX_ACCOUNTS} bank accounts` });
    }
    if (duplicate) return res.status(409).json({ error: 'This bank account is already saved' });

    if (is_default) {
      await BankAccount.updateMany({ user_id: req.userId }, { is_default: false });
    }
    const account = await BankAccount.create({
      user_id: req.userId, bank_name, account_name, account_number,
      bank_code, is_default,
    });
    res.status(201).json({ bank_account: account });
  } catch (err) {
    serverError(res, err);
  }
});

bankAccountsRouter.put('/:id/default', async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid account id' });
    const account = await BankAccount.findOne({ _id: req.params.id, user_id: req.userId });
    if (!account) return res.status(404).json({ error: 'Account not found' });
    await BankAccount.updateMany({ user_id: req.userId }, { is_default: false });
    account.is_default = true;
    await account.save();
    res.json({ bank_account: account });
  } catch (err) {
    serverError(res, err);
  }
});

bankAccountsRouter.delete('/:id', async (req, res) => {
  try {
    if (!isObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid account id' });
    const account = await BankAccount.findOneAndDelete({ _id: req.params.id, user_id: req.userId });
    if (!account) return res.status(404).json({ error: 'Account not found' });
    res.json({ success: true });
  } catch (err) {
    serverError(res, err);
  }
});