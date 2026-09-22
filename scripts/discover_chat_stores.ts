import { join, resolve } from 'node:path';
const { discoverChatStores } = require(resolve(process.cwd(), 'build/electron/runtime/context_chat_files')) as { discoverChatStores(userDataDir: string, roots: string[]): Promise<unknown> };
const args = process.argv.slice(2),
  roots = args.flatMap((value, index) =>
    value === '--root' && args[index + 1] ? [resolve(args[index + 1]!)] : [],
  ),
  userDataDir =
    process.env.MAGIC_POINTER_USER_DATA_DIR ||
    join(process.env.LOCALAPPDATA || process.cwd(), 'Magic Pointer');
discoverChatStores(userDataDir, roots)
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    console.error(`cache: ${join(userDataDir, 'chat-stores.json')}`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
