import type {PocketDatabase} from '../database'
import {digest} from './protocol'
export interface SyncIdentity {spaceId:string;deviceId:string;publicKey:JsonWebKey;privateKey:CryptoKey;label:string}
export const randomId=(bytes=32)=>[...crypto.getRandomValues(new Uint8Array(bytes))].map(n=>n.toString(16).padStart(2,'0')).join('')
export const toBase64=(bytes:Uint8Array)=>{let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s)}
export const fromBase64=(s:string)=>Uint8Array.from(atob(s),c=>c.charCodeAt(0))
export async function newSyncIdentity(spaceId:string,label:string):Promise<SyncIdentity>{const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);return {spaceId,deviceId:randomId(16),label,publicKey:await crypto.subtle.exportKey('jwk',pair.publicKey),privateKey:pair.privateKey}}
export async function signedHeaders(identity:SyncIdentity,action:string,body:string,now=Date.now(),nonce=randomId(16)){
 const hash=await digest(new TextEncoder().encode(body)),envelope=JSON.stringify(['lifeos-sync-auth-v1',identity.spaceId,identity.deviceId,action,String(now),nonce,hash])
 const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},identity.privateKey,new TextEncoder().encode(envelope))
 return {'Content-Type':'application/json','X-LifeOS-Space':identity.spaceId,'X-LifeOS-Device':identity.deviceId,'X-LifeOS-Time':String(now),'X-LifeOS-Nonce':nonce,'X-LifeOS-Signature':toBase64(new Uint8Array(signature))}
}
export async function saveSyncIdentity(db:PocketDatabase,identity:SyncIdentity){if(identity.privateKey.extractable)throw Error('同步私钥必须不可导出');await db.local.put({key:'sync-identity-v1',value:identity})}
export async function encryptRecovery(spaceId:string,recovery:string,password:string){
 if(!/^[a-f0-9]{64}$/.test(spaceId)||!/^[a-f0-9]{64}$/.test(recovery))throw Error('恢复凭证格式无效')
 if(password.length<12)throw Error('恢复文件密码至少12个字符，仅在本机使用')
 const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),material=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey'])
 const key=await crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:600000,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt'])
 const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify({spaceId,recovery})))
 return {format:'lifeos-sync-recovery-v1',iterations:600000,salt:toBase64(salt),iv:toBase64(iv),data:toBase64(new Uint8Array(ciphertext))}
}
export async function decryptRecovery(value:any,password:string):Promise<{spaceId:string;recovery:string}>{
 if(value?.format!=='lifeos-sync-recovery-v1'||value.iterations!==600000||typeof value.data!=='string'||value.data.length>10000||typeof value.salt!=='string'||value.salt.length!==24||typeof value.iv!=='string'||value.iv.length!==16)throw Error('恢复文件格式无效')
 const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']),key=await crypto.subtle.deriveKey({name:'PBKDF2',salt:fromBase64(value.salt),iterations:600000,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['decrypt'])
 const result=JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:fromBase64(value.iv)},key,fromBase64(value.data))))
 if(!/^[a-f0-9]{64}$/.test(result.spaceId)||!/^[a-f0-9]{64}$/.test(result.recovery))throw Error('恢复凭证无效');return result
}
