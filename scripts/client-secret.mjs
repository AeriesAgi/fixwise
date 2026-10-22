// Generates an OAuth client secret for the Alexa+ add-on and its SHA-256 hash. The secret goes to the Alexa CLI;
// only the hash goes into SSM. Writes the secret to a 0600 file path given as argv[2]; prints only the hash.
import { writeFileSync } from 'node:fs';
import { randomToken, sha256 } from '../src/util.js';
const s = randomToken(32); writeFileSync(process.argv[2], s + '\n', { mode: 0o600 }); console.log(await sha256(s));
