// One-off migration: store every User.phone in E.164 (+234...), the same format
// the invite matching uses. Run BEFORE the unique phone index is built, because
// duplicates make that index fail.
//
//   node scripts/normalize-phones.js           -> dry run, changes nothing
//   node scripts/normalize-phones.js --apply   -> writes the changes
//
// Changed numbers get phone_verified = false. Duplicates and invalid numbers are
// only reported: resolve them by hand.

import 'dotenv/config';
import mongoose from 'mongoose';
import { User } from '../src/models/User.js';
import { normalizePhone } from '../src/utils/phone.js';

const APPLY = process.argv.includes('--apply');

await mongoose.connect(process.env.MONGODB_URI);

const users = await User.find({ phone: { $type: 'string' } }).select('phone full_name email');

// Users whose number is already normalized go first, so they win any tie.
users.sort((a, b) => Number(normalizePhone(b.phone) === b.phone) - Number(normalizePhone(a.phone) === a.phone));

const seen = new Map();
let changed = 0;
const invalid = [];
const duplicates = [];

for (const u of users) {
  const n = normalizePhone(u.phone);
  if (!n || !/^\+\d{10,15}$/.test(n)) {
    invalid.push(`${u._id}  "${u.phone}"  ${u.email}`);
    continue;
  }
  if (seen.has(n)) {
    duplicates.push(`${u._id}  "${u.phone}" -> ${n}  (already used by ${seen.get(n)})  ${u.email}`);
    continue;
  }
  seen.set(n, u._id);
  if (n !== u.phone) {
    changed++;
    console.log(`${APPLY ? 'UPDATE' : 'would update'} ${u._id}: "${u.phone}" -> ${n}`);
    if (APPLY) await User.updateOne({ _id: u._id }, { $set: { phone: n, phone_verified: false } });
  }
}

console.log(`\n${users.length} users with a phone. ${changed} ${APPLY ? 'updated' : 'would be updated'}.`);
if (invalid.length) console.log(`\nINVALID numbers (fix by hand):\n${invalid.join('\n')}`);
if (duplicates.length) console.log(`\nDUPLICATES (fix by hand before the unique index will build):\n${duplicates.join('\n')}`);
if (!APPLY) console.log('\nDry run only. Re-run with --apply to write changes.');

await mongoose.disconnect();