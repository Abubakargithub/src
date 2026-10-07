import { Router } from 'express';
import { BankAccount } from '../models/BankAccount.js';
import { authMiddleware } from '../middleware/auth.js';

export const bankAccountsRouter = Router();

bankAccountsRouter.use(authMiddleware);

bankAccountsRouter.get('/', async (req, res) => {
  try {
    const accounts = await BankAccount.find({ user_id: req.userId }).sort({ created_at: -1 });
    res.json({ bank_accounts: accounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

bankAccountsRouter.post('/', async (req, res) => {
  try {
    const { bank_name, account_name, account_number, bank_code, is_default } = req.body;
    if (!bank_name || !account_name || !account_number) {
      return res.status(400).json({ error: 'bank_name, account_name, and account_number are required' });
    }
    if (is_default) {
      await BankAccount.updateMany({ user_id: req.userId }, { is_default: false });
    }
    const account = await BankAccount.create({
      user_id: req.userId, bank_name, account_name, account_number,
      bank_code: bank_code || null, is_default: is_default || false,
    });
    res.status(201).json({ bank_account: account });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

bankAccountsRouter.put('/:id/default', async (req, res) => {
  try {
    await BankAccount.updateMany({ user_id: req.userId }, { is_default: false });
    const account = await BankAccount.findByIdAndUpdate(req.params.id, { is_default: true }, { new: true });
    if (!account) return res.status(404).json({ error: 'Account not found' });
    res.json({ bank_account: account });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

bankAccountsRouter.delete('/:id', async (req, res) => {
  try {
    await BankAccount.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
