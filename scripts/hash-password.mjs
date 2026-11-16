// Generates the values for the authentication settings. Run:
//   node scripts/hash-password.mjs
// The password is read from the terminal (not from the command line, so it
// doesn't land in your shell history) and is never written anywhere.
import { randomBytes, scrypt } from "node:crypto";
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.stdoutMuted = false;
const origWrite = rl._writeToOutput;
rl._writeToOutput = function (s) {
  if (rl.stdoutMuted) return;
  origWrite.call(rl, s);
};

rl.question("Choose a password (at least 12 characters): ", (password) => {
  rl.close();
  process.stdout.write("\n");
  if (password.length < 12) {
    console.error("Too short. Use at least 12 characters.");
    process.exit(1);
  }
  const salt = randomBytes(16);
  scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => {
    if (err) throw err;
    const hash = `scrypt:16384:8:1:${salt.toString("base64")}:${key.toString("base64")}`;
    console.log("Add these to .env.local (or your host's environment) and restart:\n");
    console.log("AUTH_USERNAME=admin");
    console.log(`AUTH_PASSWORD_HASH=${hash}`);
    console.log(`AUTH_SESSION_SECRET=${randomBytes(48).toString("base64url")}`);
  });
});
rl.stdoutMuted = true;
