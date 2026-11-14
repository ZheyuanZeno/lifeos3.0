import {mkdir,writeFile,access} from 'node:fs/promises'
import {resolve,relative,isAbsolute,sep} from 'node:path'
import {randomBytes} from 'node:crypto'
import webpush from 'web-push'
const target=resolve(process.argv[2]??''),inside=relative(resolve('.'),target)
if(!process.argv[2]||!isAbsolute(inside)&&inside!=='..'&&!inside.startsWith('..'+sep))throw Error('Choose a private directory outside the repository')
await mkdir(target,{recursive:true})
const filename=resolve(target,'worker-secrets.json')
try{await access(filename);console.log('Reusing existing notification server keys outside repository')}
catch{const keys=webpush.generateVAPIDKeys();await writeFile(filename,JSON.stringify({VAPID_PUBLIC_KEY:keys.publicKey,VAPID_PRIVATE_KEY:keys.privateKey,DEVICE_AUTH_SECRET:randomBytes(48).toString('base64url')}),{flag:'wx',mode:0o600});console.log('Created notification server keys outside repository')}
