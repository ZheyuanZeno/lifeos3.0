import type {PushSubscription} from 'web-push'
export const safeId=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(v)
export function subscription(value:unknown):PushSubscription{
 const s=value as PushSubscription
 if(!s||typeof s.endpoint!=='string'||s.endpoint.length>2048)throw Error('推送订阅无效')
 const u=new URL(s.endpoint)
 const domains=['web.push.apple.com','push.apple.com','fcm.googleapis.com','updates.push.services.mozilla.com','push.services.mozilla.com']
 if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||!domains.some(h=>u.hostname===h||u.hostname.endsWith('.'+h)))throw Error('推送地址无效')
 if(!s.keys||!/^[-_A-Za-z0-9]{87}$/.test(s.keys.p256dh)||!/^[-_A-Za-z0-9]{22}$/.test(s.keys.auth)||Buffer.from(s.keys.p256dh,'base64url')[0]!==4)throw Error('推送密钥无效')
 return {endpoint:s.endpoint,keys:{p256dh:s.keys.p256dh,auth:s.keys.auth}}
}
export interface DeviceClaim {account:string;device:string;nonce:string;expires:number}
const key=(secret:string)=>crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify'])
export async function sign(claim:DeviceClaim,secret:string){const payload=Buffer.from(JSON.stringify(claim)).toString('base64url');const signature=await crypto.subtle.sign('HMAC',await key(secret),new TextEncoder().encode(payload));return payload+'.'+Buffer.from(signature).toString('base64url')}
export async function verify(token:string,secret:string,now=Date.now()):Promise<DeviceClaim>{
 try{
  if(token.length>2048)throw Error()
  const [payload,signature,...extra]=token.split('.')
  if(extra.length||!payload||!signature||!await crypto.subtle.verify('HMAC',await key(secret),Buffer.from(signature,'base64url'),new TextEncoder().encode(payload)))throw Error()
  const c=JSON.parse(Buffer.from(payload,'base64url').toString()) as DeviceClaim
  if(!safeId(c.account)||!safeId(c.device)||!safeId(c.nonce)||!Number.isFinite(c.expires)||c.expires<=now)throw Error()
  return c
 }catch{throw Error('通知设备凭证已失效，请重新连接 Google 后开启通知')}
}
export async function accountKey(permissionId:string){return Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(permissionId))).toString('hex')}
