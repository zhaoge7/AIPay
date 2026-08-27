import console from 'node:console';
import { generateKeyPairSync } from 'node:crypto';

import { v7 as uuidv7 } from 'uuid';

const { privateKey } = generateKeyPairSync('ed25519');
const privateKeyPkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' });

console.log(`AIPAY_MANDATE_SIGNING_KEY_ID=key_${uuidv7()}`);
console.log(`AIPAY_MANDATE_SIGNING_PRIVATE_KEY=${privateKeyPkcs8.toString('base64')}`);
