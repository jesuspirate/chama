import { lstatSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Output is captured into SIGN_WITH by the shell, never printed to release logs.
const file = process.argv[2];
try {
  let stat;
  try { stat = lstatSync(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (process.env.CHAMA_ZAPSTORE_SIGNER_FILE) throw new Error('Configured connection is missing');
    process.stdout.write('browser');
    process.exit(0);
  }
  const parent = lstatSync(dirname(file));
  if (!stat.isFile() || !parent.isDirectory() ||
      (stat.mode & 0o077) !== 0 || (parent.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid() || parent.uid !== process.getuid()) {
    throw new Error('Connection needs an owner-only file and directory (0600 / 0700)');
  }
  const connection = readFileSync(file, 'utf8').trim();
  const url = new URL(connection);
  if (url.protocol !== 'bunker:' || !/^[a-f0-9]{64}$/i.test(url.hostname) ||
      !url.searchParams.getAll('relay').some(relay => new URL(relay).protocol === 'wss:')) {
    throw new Error('Invalid Amber connection');
  }
  process.stdout.write(connection);
} catch {
  // Errors from URL parsing can contain the pairing secret. Never include them.
  console.error('Cannot load Zapstore signer. Check the private connection file, ownership and permissions.');
  process.exit(1);
}
