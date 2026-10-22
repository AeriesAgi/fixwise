// Prints a PBKDF2 hash for a household passcode read from stdin (never pass secrets as argv).
import { pbkdf2, b64url } from '../src/util.js';
let pass = ''; for await (const c of process.stdin) pass += c; pass = pass.trim();
const salt = b64url(crypto.getRandomValues(new Uint8Array(16)));
console.log(`pbkdf2$310000$${salt}$${await pbkdf2(pass, salt, 310000)}`);
