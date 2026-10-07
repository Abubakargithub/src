import 'dotenv/config';
import mongoose from 'mongoose';
import { Contribution } from '../models/Contribution.js';
import { DVA } from '../models/DVA.js';
import { Member } from '../models/Member.js';
import { User } from '../models/User.js';
import { Transfer } from '../models/Transfer.js';
import { TransferRecipient } from '../models/TransferRecipient.js';
await mongoose.connect(process.env.MONGODB_URI);

let problems = 0;
async function report(title, model, match, groupId) {
  const rows = await model.aggregate([
    { $match: match },
    { $group: { _id: groupId, count: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  console.log(`\n${title}: ${rows.length ? rows.length + ' DUPLICATE(S)' : 'ok'}`);
  for (const r of rows) console.log(`  key=${JSON.stringify(r._id)}  ids=${r.ids.join(', ')}`);
  problems += rows.length;
}

await report('Contribution.reference', Contribution,
  { reference: { $type: 'string' } }, '$reference');
await report('Contribution (group, member, series) completed', Contribution,
  { status: 'completed' }, { g: '$group_id', m: '$member_id', s: '$series_number' });
await report('DVA active (group, member, series)', DVA,
  { status: 'active' }, { g: '$group_id', m: '$member_id', s: '$series_number' });
await report('Member active (group, user)', Member,
  { status: 'active', user_id: { $type: 'objectId' } }, { g: '$group_id', u: '$user_id' });
await report('Transfer successful (group, series): a series paid out twice', Transfer,
  { status: 'success' }, { g: '$group_id', s: '$series_number' });
await report('TransferRecipient (user, account, bank)', TransferRecipient,
  {}, { u: '$user_id', a: '$account_number', b: '$bank_code' });
await report('User.phone', User,
  { phone: { $type: 'string' } }, '$phone');
await report('User.identity_hash', User,
  { identity_hash: { $type: 'string' } }, '$identity_hash');

console.log(problems ? `\n${problems} problem(s) found. Fix them before deploying.` : '\nNo duplicates. Safe to deploy.');
await mongoose.disconnect();