// One-time local setup for a new template copy, never routine key rotation.
import {generateKeyPairSync} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
if(process.argv[2]!=='--new-installation')throw new Error('Use --new-installation only for a fresh repository with no healing history');
const {publicKey,privateKey}=generateKeyPairSync('ed25519');
await mkdir('.heal-output',{recursive:true});
await writeFile('.heal-output/state-private.pem',privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600});
const policy=JSON.parse(await readFile('.self-heal/policy.json','utf8'));
policy.statePublicKey=publicKey.export({type:'spki',format:'pem'});
await writeFile('.self-heal/policy.json',JSON.stringify(policy,null,2)+'\n');
console.log('Public key saved in policy. Private key is in ignored .heal-output/state-private.pem.');
console.log('Add the private key as HEAL_STATE_PRIVATE_KEY in the main-only heal-control environment, then delete the local private file. Never commit it.');
