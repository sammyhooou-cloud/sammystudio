import { pbkdf2 } from 'node:crypto';
import { promisify } from 'node:util';

const password = process.env.ADMIN_PASSWORD_INPUT;
if (!password) throw new Error('Set ADMIN_PASSWORD_INPUT for this one process. The value is never written.');
const iterations = 210000;
const salt = crypto.getRandomValues(new Uint8Array(18));
const derived = await promisify(pbkdf2)(password, salt, iterations, 32, 'sha256');
process.stdout.write(`pbkdf2-sha256$${iterations}$${Buffer.from(salt).toString('base64')}$${derived.toString('base64')}\n`);
