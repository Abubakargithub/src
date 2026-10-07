import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { User } from './models/User.js';
import { Group } from './models/Group.js';
import { Member } from './models/Member.js';
import { Contribution } from './models/Contribution.js';
import { Activity } from './models/Activity.js';
import { Schedule } from './models/Schedule.js';

async function seed() {
  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) {
    console.error('MONGODB_URI is required');
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB, seeding...');

  await Promise.all([
    User.deleteMany({}),
    Group.deleteMany({}),
    Member.deleteMany({}),
    Contribution.deleteMany({}),
    Activity.deleteMany({}),
    Schedule.deleteMany({}),
  ]);

  const password_hash = await bcrypt.hash('password123', 10);
  const user = await User.create({
    full_name: 'Aisha Okeke',
    email: 'demo@dashe.app',
    password_hash,
    phone: '+234 803 111 2222',
    verified: true,
  });
  console.log('Created demo user:', user.email);

  const group = await Group.create({
    name: 'Gwoza Family Dashe',
    description: 'Family rotating contribution group for weekly savings.',
    category: 'Family',
    contribution_amount: 50000,
    frequency: 'Weekly',
    member_count: 6,
    start_date: '2026-08-23',
    contribution_day: 'Saturday',
    fee_payer: 'Member pays',
    status: 'active',
    current_series: 2,
    owner_id: user._id,
  });
  console.log('Created group:', group.name);

  const memberData = [
    { name: 'Aisha Okeke', initials: 'AO', position: 1, role: 'member', paid_count: 3, status: 'active', user_id: user._id },
    { name: 'You', initials: 'YO', position: 2, role: 'creator', paid_count: 3, status: 'active', user_id: user._id },
    { name: 'Abdul Karim', initials: 'AK', position: 3, role: 'member', paid_count: 2, status: 'active' },
    { name: 'Fatima Ali', initials: 'FA', position: 4, role: 'member', paid_count: 2, status: 'pending' },
    { name: 'Musa Usman', initials: 'MU', position: 5, role: 'member', paid_count: 3, status: 'active' },
    { name: 'Hauwa Bello', initials: 'HB', position: 6, role: 'member', paid_count: 3, status: 'active' },
  ];
  const members = [];
  for (const m of memberData) {
    members.push(await Member.create({ group_id: group._id, ...m }));
  }
  console.log('Created', members.length, 'members');

  const series1 = [
    { member: members[0], name: 'Aisha Okeke', method: 'card', date: '2026-08-23', ref: 'TXN-AO-S1' },
    { member: members[1], name: 'You', method: 'ussd', date: '2026-08-23', ref: 'TXN-YO-S1' },
    { member: members[2], name: 'Abdul Karim', method: 'card', date: '2026-08-23', ref: 'TXN-AK-S1' },
    { member: members[3], name: 'Fatima Ali', method: 'bank', date: '2026-08-23', ref: 'TXN-FA-S1' },
    { member: members[4], name: 'Musa Usman', method: 'card', date: '2026-08-23', ref: 'TXN-MU-S1' },
    { member: members[5], name: 'Hauwa Bello', method: 'ussd', date: '2026-08-23', ref: 'TXN-HB-S1' },
  ];
  for (const c of series1) {
    await Contribution.create({
      group_id: group._id, member_id: c.member._id, member_name: c.name,
      series_number: 1, amount: 50000, status: 'completed',
      payment_method: c.method, due_date: c.date, paid_at: new Date(c.date), reference: c.ref,
    });
  }

  const series2 = [
    { member: members[1], name: 'You', method: 'card', date: '2026-08-27', ref: 'TXN-YO-S2', status: 'completed' },
    { member: members[2], name: 'Abdul Karim', method: 'card', date: '2026-08-27', ref: 'TXN-AK-S2', status: 'completed' },
    { member: members[4], name: 'Musa Usman', method: 'ussd', date: '2026-08-27', ref: 'TXN-MU-S2', status: 'completed' },
    { member: members[3], name: 'Fatima Ali', method: 'card', date: '2026-08-27', ref: 'TXN-FA-S2-PENDING', status: 'pending' },
    { member: members[0], name: 'Aisha Okeke', method: 'bank', date: '2026-08-27', ref: 'TXN-AO-S2-PENDING', status: 'pending' },
    { member: members[5], name: 'Hauwa Bello', method: 'card', date: '2026-08-27', ref: 'TXN-HB-S2-PENDING', status: 'pending' },
  ];
  for (const c of series2) {
    await Contribution.create({
      group_id: group._id, member_id: c.member._id, member_name: c.name,
      series_number: 2, amount: 50000, status: c.status,
      payment_method: c.method, due_date: c.date,
      paid_at: c.status === 'completed' ? new Date(c.date) : null, reference: c.ref,
    });
  }
  console.log('Created contributions');

  const activities = [
    { member_id: members[1]._id, type: 'contribution', title: 'You contributed ₦50,000', amount: 50000, status: 'completed', method: 'card', ref: 'TXN-YO-S2', meta: 'Gwoza Family Dashe  ·  Series 2  ·  10:15 AM', date: '2026-08-27T10:15:00+01:00' },
    { member_id: members[2]._id, type: 'contribution', title: 'Abdul contributed ₦50,000', amount: 50000, status: 'completed', method: 'card', ref: 'TXN-AK-S2', meta: 'Gwoza Family Dashe  ·  Series 2  ·  9:48 AM', date: '2026-08-27T09:48:00+01:00' },
    { member_id: members[3]._id, type: 'due', title: 'Fatima is yet to contribute', amount: 50000, status: 'due', method: 'card', ref: 'TXN-FA-S2-PENDING', meta: 'Gwoza Family Dashe  ·  Series 2  ·  Due 6:00 PM', date: '2026-08-27T18:00:00+01:00' },
    { member_id: members[0]._id, type: 'cashout', title: 'Aisha received ₦250,000', amount: 250000, status: 'completed', method: 'card', ref: 'CASHOUT-S1', meta: 'Gwoza Family Dashe  ·  Series 1  ·  Card', date: '2026-08-26T12:00:00+01:00' },
    { member_id: members[1]._id, type: 'contribution', title: 'You contributed ₦50,000', amount: 50000, status: 'completed', method: 'ussd', ref: 'TXN-YO-S1', meta: 'Gwoza Family Dashe  ·  Series 1  ·  USSD', date: '2026-08-26T11:30:00+01:00' },
    { member_id: members[4]._id, type: 'member', title: 'Musa joined Gwoza Family Dashe', amount: null, status: 'completed', method: null, ref: null, meta: 'Invited by you  ·  4:22 PM', date: '2026-08-24T16:22:00+01:00' },
    { member_id: members[1]._id, type: 'failed', title: 'Payment of ₦50,000 failed', amount: 50000, status: 'failed', method: 'card', ref: 'TXN-FAIL-S1', meta: 'Gwoza Family Dashe  ·  Series 1  ·  Card', date: '2026-08-24T15:00:00+01:00' },
  ];
  for (const a of activities) {
    await Activity.create({ group_id: group._id, ...a, created_at: new Date(a.date) });
  }
  console.log('Created activities');

  for (let i = 0; i < 6; i++) {
    const due = new Date('2026-08-23');
    due.setDate(due.getDate() + i * 7);
    await Schedule.create({ group_id: group._id, series_number: i + 1, due_date: due.toISOString().slice(0, 10), status: i < 1 ? 'completed' : i < 2 ? 'in_progress' : 'pending' });
  }
  console.log('Created schedule');

  await Group.create({
    name: 'Office Cooperative', description: 'Monthly office cooperative savings group.',
    category: 'Cooperative', contribution_amount: 20000, frequency: 'Monthly',
    member_count: 10, start_date: '2026-08-01', contribution_day: 'Monthly',
    fee_payer: 'Creator pays', status: 'active', current_series: 5, owner_id: user._id,
  });
  await Group.create({
    name: 'Friday Friends Club', description: 'Friends weekly contribution circle.',
    category: 'Friends', contribution_amount: 10000, frequency: 'Weekly',
    member_count: 5, start_date: '2026-09-05', contribution_day: 'Friday',
    fee_payer: 'Shared', status: 'upcoming', current_series: 0, owner_id: user._id,
  });
  console.log('Created additional groups');

  console.log('\nSeed complete!');
  console.log('Login with: demo@dashe.app / password123');
  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed error:', err);
  process.exit(1);
});
