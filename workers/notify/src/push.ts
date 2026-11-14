import webpush from 'web-push'
import type {PushSubscription} from 'web-push'
export interface PushEnv {VAPID_PUBLIC_KEY:string;VAPID_PRIVATE_KEY:string}
export async function sendPush(env:PushEnv,to:PushSubscription,payload:{title:string;body:string;id?:string;tag:string},fetcher:typeof fetch=fetch):Promise<number>{
 const topic=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload.tag))).toString('base64url').slice(0,32)
 const details=webpush.generateRequestDetails(to,JSON.stringify(payload),{TTL:900,urgency:'high',topic,contentEncoding:'aes128gcm',vapidDetails:{subject:'https://lifeos-pocket.pages.dev/',publicKey:env.VAPID_PUBLIC_KEY,privateKey:env.VAPID_PRIVATE_KEY}})
 const response=await fetcher(details.endpoint,{method:'POST',headers:details.headers,body:details.body as unknown as BodyInit,redirect:'manual',signal:AbortSignal.timeout(10000)})
 await response.body?.cancel()
 return response.status
}
