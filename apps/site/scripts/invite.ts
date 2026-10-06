import {
  inviteAndNotify,
  listInvites,
  revokeInvite,
  sendInviteNotification,
} from '../src/lib/server/hosted-invite.js';

const usage =
  'Usage: pnpm --filter @willgriffin/iolaus-site invite:add|invite:resend|invite:revoke|invite:list -- [<email>] [--no-email]';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const sendEmail = !args.includes('--no-email');
const [command, ...rest] = args.filter((arg) => arg !== '--no-email');

function reportEmail(outcome: { status: string; reason?: string }): void {
  if (outcome.status === 'skipped' || outcome.status === 'failed') {
    console.error(`No invitation email sent: ${outcome.reason}`);
  }
  if (outcome.status === 'failed' || outcome.status === 'not-invited') {
    process.exitCode = 1;
  }
}

if (command === 'list' && rest.length === 0) {
  console.log(JSON.stringify(await listInvites(), null, 2));
} else if (command === 'add' && rest.length === 1) {
  const result = await inviteAndNotify(rest[0], { sendEmail });
  console.log(JSON.stringify(result, null, 2));
  reportEmail(result.emailOutcome);
} else if (command === 'resend' && rest.length === 1) {
  const outcome = await sendInviteNotification(rest[0]);
  console.log(
    JSON.stringify({ email: rest[0], emailOutcome: outcome }, null, 2),
  );
  reportEmail(outcome);
  if (outcome.status === 'skipped') process.exitCode = 1;
} else if (command === 'revoke' && rest.length === 1) {
  const result = await revokeInvite(rest[0]);
  console.log(JSON.stringify(result, null, 2));
  if (result.result === 'not-found') process.exitCode = 1;
} else {
  console.error(usage);
  process.exitCode = 2;
}
process.exit(process.exitCode ?? 0);
