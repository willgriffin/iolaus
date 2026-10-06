import {
  addInvite,
  listInvites,
  revokeInvite,
} from '../src/lib/server/hosted-invite.js';

const usage =
  'Usage: pnpm --filter @willgriffin/iolaus-site invite:add|invite:revoke|invite:list -- [<email>]';

const [command, ...rest] = process.argv.slice(2).filter((arg) => arg !== '--');

if (command === 'list' && rest.length === 0) {
  console.log(JSON.stringify(await listInvites(), null, 2));
} else if ((command === 'add' || command === 'revoke') && rest.length === 1) {
  const result =
    command === 'add' ? await addInvite(rest[0]) : await revokeInvite(rest[0]);
  console.log(JSON.stringify(result, null, 2));
  if (result.result === 'not-found') process.exitCode = 1;
} else {
  console.error(usage);
  process.exitCode = 2;
}
process.exit(process.exitCode ?? 0);
