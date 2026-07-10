/**
 * Operational CLI for the team directory — run it in the Render Shell (it opens
 * the same SQLite DB the server uses, via config/DATA_DIR, so there is no path
 * or shell-escaping guesswork):
 *
 *   npm run admin -w apps/server -- list                     # who's who + what the app sees
 *   npm run admin -w apps/server -- make-lead you@company.com # force an AP Lead
 *   npm run admin -w apps/server -- purge-demo                # drop the sample people
 */
import { config, ensureDataDirs } from '../src/config.js';
import { all, getDb, one, openDb, run } from '../src/db/db.js';
import { nowIso } from '../src/domain/util.js';

// The sample accounts this build seeds in dev (all @example.com, RFC-reserved).
const SAMPLE_EMAILS = [
  'amy@example.com', 'rory@example.com', 'niamh@example.com', 'cian@example.com',
  'orla@example.com', 'dara@example.com', 'j.brennan@example.com', 'm.obrien@example.com',
  's.kavanagh@example.com', 'a.doyle@example.com', 'f.nolan@example.com',
];

function list(): void {
  console.log(`AUTH_PROVIDER     = ${config.authProvider}`);
  console.log(`FINNY_LEAD_EMAILS = ${config.leadEmails.join(', ') || '(none)'}`);
  console.log('\nTeam members — this is the exact email the app matches against, and each role:');
  const team = all<{ email: string; role: string; source: string; in_group: number | bigint }>(
    'SELECT email, role, source, in_group FROM team_members ORDER BY role DESC, email',
  );
  if (!team.length) console.log('  (none yet)');
  for (const m of team) {
    console.log(`  ${String(m.role).padEnd(9)} ${m.email}${Number(m.in_group) ? '' : '  [not in group]'}  (${m.source})`);
  }
  console.log('\nApprovers:');
  const approvers = all<{ email: string; active: number | bigint; source: string }>(
    'SELECT email, active, source FROM approvers ORDER BY email',
  );
  if (!approvers.length) console.log('  (none yet)');
  for (const a of approvers) {
    console.log(`  ${Number(a.active) ? 'active  ' : 'inactive'} ${a.email}  (${a.source})`);
  }
}

function makeLead(rawEmail: string): void {
  const email = rawEmail.trim().toLowerCase();
  if (!email.includes('@')) {
    console.error(`"${rawEmail}" is not an email address.`);
    process.exit(1);
  }
  const existing = one('SELECT email FROM team_members WHERE email = ?', email);
  if (existing) {
    run(
      "UPDATE team_members SET role = 'lead', source = 'manual', updated_at = ?, updated_by = 'admin-cli' WHERE email = ?",
      nowIso(),
      email,
    );
  } else {
    run(
      "INSERT INTO team_members (email, name, role, source, in_group, updated_at, updated_by) VALUES (?, ?, 'lead', 'manual', 1, ?, 'admin-cli')",
      email,
      email,
      nowIso(),
    );
  }
  console.log(`✓ ${email} is now an AP Lead. They may need to reload the page (no re-login needed).`);
}

function purgeDemo(): void {
  const placeholders = SAMPLE_EMAILS.map(() => '?').join(', ');
  const team = run(`DELETE FROM team_members WHERE email IN (${placeholders})`, ...SAMPLE_EMAILS);
  const appr = run(
    `DELETE FROM approvers WHERE source = 'graph' AND email IN (${placeholders})`,
    ...SAMPLE_EMAILS,
  );
  console.log(`✓ Removed ${Number(team.changes)} sample team member(s) and ${Number(appr.changes)} sample approver(s).`);
}

function main(): void {
  const [cmd, arg] = process.argv.slice(2);
  ensureDataDirs();
  openDb(config.dbPath);
  getDb().exec('PRAGMA busy_timeout = 4000'); // tolerate the running server's writes
  switch (cmd) {
    case 'list':
      list();
      break;
    case 'make-lead':
      if (!arg) {
        console.error('Usage: npm run admin -w apps/server -- make-lead you@company.com');
        process.exit(1);
      }
      makeLead(arg);
      break;
    case 'purge-demo':
      purgeDemo();
      break;
    default:
      console.error('Commands:\n  list\n  make-lead <email>\n  purge-demo');
      process.exit(1);
  }
}

main();
