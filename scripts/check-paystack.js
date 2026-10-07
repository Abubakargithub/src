// Usage (works from any folder):
//   node src/scripts/check-paystack.js                 -> balance, recent DVA credits, settlements
//   node src/scripts/check-paystack.js --need=50000    -> also compare balance to a payout amount (NGN)
//   node src/scripts/check-paystack.js --probe         -> also test whether transfers are enabled
//                                                         (uses a fake recipient, so no money can move)
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Look for .env next to the script, in parent folders, and in the current folder.
const here = path.dirname(fileURLToPath(import.meta.url));
const envCandidates = [
  path.resolve(here, '../../.env'), // server/.env (script in server/src/scripts)
  path.resolve(here, '../.env'),    // script in server/scripts
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../.env'),
];
const envFile = envCandidates.find(p => fs.existsSync(p));
if (envFile) {
  process.loadEnvFile(envFile);
  console.log(`Loaded env from ${envFile}`);
} else {
  console.log('No .env file found. Using the real environment only.');
}

const KEY = process.env.PAYSTACK_SECRET_KEY || '';
const BASE = 'https://api.paystack.co';
const args = process.argv.slice(2);
const needArg = args.find(a => a.startsWith('--need='));
const NEED_NGN = needArg ? Number(needArg.split('=')[1]) : null;
const PROBE = args.includes('--probe');

const naira = kobo => `₦${(Number(kobo || 0) / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
const ok = msg => console.log(`  ✅ ${msg}`);
const warn = msg => console.log(`  ⚠️  ${msg}`);
const bad = msg => console.log(`  ❌ ${msg}`);
const head = msg => console.log(`\n${msg}`);

const api = axios.create({
  baseURL: BASE,
  timeout: 15000,
  headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
});
const errMsg = err => err.response?.data?.message || err.message;

let problems = 0;

async function main() {
  if (!KEY || KEY.startsWith('sk_test_xxx')) {
    bad('PAYSTACK_SECRET_KEY is missing or still a placeholder.');
    console.log('  Check that server/.env has a line like: PAYSTACK_SECRET_KEY=sk_live_... (no quotes, no spaces around =)');
    process.exit(1);
  }

  const mode = KEY.startsWith('sk_live_') ? 'LIVE' : 'TEST';
  console.log(`Paystack mode: ${mode}`);
  if (mode === 'TEST') warn('Test mode: no real money settles. Test balance is whatever you top up in the dashboard.');

  const windowStart = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  const windowDay = windowStart.toISOString().slice(0, 10);

  // Settlements are fetched first because section 2 compares credits against them.
  let settlements = [];
  let settlementsOk = true;
  try {
    const { data } = await api.get('/settlement?perPage=10');
    settlements = data.data || [];
  } catch (err) {
    settlementsOk = false;
    console.log(`(Could not list settlements: ${errMsg(err)})`);
  }
  const settlementDay = s => String(s.settlement_date || s.createdAt || '').slice(0, 10);
  const recentSettledKobo = settlements
    .filter(s => settlementDay(s) >= windowDay && s.status === 'success')
    .reduce((sum, s) => sum + (Number(s.total_amount) || 0), 0);

  // 1. Settled (spendable) balance
  head('1) Paystack balance (what a transfer can actually spend)');
  let balanceKobo = 0;
  try {
    const { data } = await api.get('/balance');
    const rows = data.data || [];
    const ngn = rows.find(b => b.currency === 'NGN');
    balanceKobo = Number(ngn?.balance) || 0;
    if (!ngn) {
      warn('No NGN balance entry returned.');
      problems++;
    } else {
      console.log(`  NGN balance: ${naira(balanceKobo)}`);
    }
    if (NEED_NGN != null) {
      const needKobo = Math.round(NEED_NGN * 100);
      if (balanceKobo >= needKobo) ok(`Enough funds for a ${naira(needKobo)} payout.`);
      else {
        bad(`Short by ${naira(needKobo - balanceKobo)}. The payout runner would skip it and log "waiting for funds to settle".`);
        problems++;
      }
    }
  } catch (err) {
    bad(`Could not read balance: ${errMsg(err)}`);
    problems++;
  }

  // 2. Recent DVA credits vs settlements
  head('2) Recent DVA credits (last 3 days)');
  try {
    const from = windowStart.toISOString();
    const { data } = await api.get(`/transaction?status=success&perPage=50&from=${encodeURIComponent(from)}`);
    const credits = (data.data || []).filter(t => t.channel === 'dedicated_nuban' && t.currency === 'NGN');
    if (credits.length === 0) {
      console.log('  No DVA credits in the last 3 days.');
    } else {
      let total = 0;
      for (const t of credits) {
        total += Number(t.amount) || 0;
        const hours = Math.round((Date.now() - new Date(t.paid_at || t.created_at).getTime()) / 3600000);
        console.log(`  ${naira(t.amount)}  ${t.reference}  ${hours}h ago`);
      }
      console.log(`  Total credited: ${naira(total)}`);
      console.log(`  Settled to your bank in this window (net of fees): ${naira(recentSettledKobo)}`);
      console.log(`  Current Paystack balance: ${naira(balanceKobo)}`);

      if (balanceKobo >= total) {
        ok('Paystack balance covers the credits received in this window.');
      } else if (settlementsOk && recentSettledKobo >= total * 0.9) {
        warn('These credits were already settled to your BANK ACCOUNT, so they are not in the Paystack balance.');
        console.log('     Payouts spend from the Paystack balance: top it up (Transfers > Balance) or change your settlement setting.');
      } else {
        warn('Balance is lower than credits and no matching settlement yet: the money is probably still in settlement (usually next business day).');
      }
    }
  } catch (err) {
    warn(`Could not list transactions: ${errMsg(err)}`);
  }

  // 3. Recent settlements
  head('3) Recent settlements');
  if (settlements.length === 0) console.log('  No settlements returned.');
  for (const s of settlements.slice(0, 5)) {
    console.log(`  ${settlementDay(s)}  ${naira(s.total_amount)}  status: ${s.status}`);
  }

  // 4. Are transfers enabled?
  head('4) Transfers enabled?');
  try {
    await api.get('/transfer?perPage=1');
    ok('Transfers API is reachable with this key.');
  } catch (err) {
    bad(`Transfers API refused the request: ${errMsg(err)}`);
    problems++;
  }

  if (!PROBE) {
    console.log('  (Run with --probe to test whether Paystack will accept transfer requests.)');
  } else {
    // Fake recipient: Paystack rejects it, so nothing can be sent.
    try {
      await api.post('/transfer', {
        source: 'balance',
        amount: 10000,
        recipient: 'RCP_doesnotexist00',
        reason: 'dashe transfer capability probe',
        reference: `dashe-probe-${Date.now()}`,
      });
      warn('Paystack unexpectedly accepted the probe. Check your dashboard transfers now.');
      problems++;
    } catch (err) {
      const msg = errMsg(err);
      const low = msg.toLowerCase();
      // Order matters: check "recipient" first, because the word contains "ip".
      if (low.includes('recipient')) {
        ok(`Transfers are ENABLED (Paystack got as far as rejecting the fake recipient: "${msg}").`);
      } else if (low.includes('insufficient') || low.includes('balance')) {
        ok(`Transfers are enabled, but the balance is insufficient: "${msg}".`);
      } else if (/\bip\b|ip address|whitelist|allow.?list/.test(low)) {
        bad(`Blocked by IP allow-list: ${msg}. Whitelist this server's IP in Settings > API Keys & Webhooks.`);
        problems++;
      } else if (low.includes('starter business') || low.includes('third party') || low.includes('not enabled') || low.includes('activate')) {
        bad(`Transfers are NOT enabled: ${msg}`);
        problems++;
      } else {
        warn(`Inconclusive. Paystack said: "${msg}"`);
      }
    }
  }

  head('Dashboard checks the API cannot show:');
  console.log('  • Settings > Preferences > Transfers: turn OFF "Confirm transfers before sending" (OTP),');
  console.log('    otherwise transfers stay in the "otp" status and never complete automatically.');

  console.log(problems === 0 ? '\nResult: looks good.' : `\nResult: ${problems} issue(s) found.`);
  process.exit(problems === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Check failed:', errMsg(err));
  process.exit(1);
});