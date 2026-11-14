import type {PushSubscription} from 'web-push'
import {canonical,reminderSchedule,validateProjection} from '../../../lifeos/pocket/src/notifications/projection'
import type {Operation} from '../../../lifeos/pocket/src/model'
import {accountKey,safeId,sign,verify,type DeviceClaim,subscription} from './security'
import {sendPush,type PushEnv} from './push'

export interface Env extends PushEnv {DEVICE_AUTH_SECRET:string;REMINDERS:DurableObjectNamespace}
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}})
const bearer=(r:Request)=>r.headers.get('Authorization')?.replace(/^Bearer /,'')??''
const limit=2*1024*1024
async function body(r:Request){if(Number(r.headers.get('Content-Length'))>limit)throw Error('通知请求超过 2MB');const raw=await r.text();if(new TextEncoder().encode(raw).length>limit)throw Error('通知请求超过 2MB');return JSON.parse(raw||'{}')}
const enabled=(env:Env)=>!!(env.VAPID_PUBLIC_KEY&&env.VAPID_PRIVATE_KEY&&env.DEVICE_AUTH_SECRET)
export default {
 async fetch(request:Request,env:Env):Promise<Response>{
  const route=new URL(request.url).pathname.replace(/\/$/,'')
  if(route==='/config'&&request.method==='GET')return json({ready:enabled(env),publicKey:enabled(env)?env.VAPID_PUBLIC_KEY:''})
  if(!enabled(env))return json({error:'通知服务尚未配置'},503)
  if(!['/enroll','/state','/subscription','/test','/device','/status'].includes(route))return json({error:'Not found'},404)
  try{
   if(route==='/enroll'&&request.method==='POST'){
    const input=await body(request)
    if(!safeId(input.deviceId)||!bearer(request))return json({error:'需要先连接 Google'},401)
    const google=await fetch('https://www.googleapis.com/drive/v3/about?fields=user(permissionId)',{headers:{Authorization:'Bearer '+bearer(request)},signal:AbortSignal.timeout(10000)})
    if(!google.ok){await google.body?.cancel();return json({error:'请重新连接 Google 后开启通知'},401)}
    const account=(await google.json() as {user?:{permissionId?:string}}).user?.permissionId
    if(!account)return json({error:'无法确认 Google 账号'},401)
    const claim:DeviceClaim={account:await accountKey(account),device:input.deviceId,nonce:crypto.randomUUID(),expires:Date.now()+365*86400000}
    const stub=env.REMINDERS.get(env.REMINDERS.idFromName(claim.account))
    const response=await stub.fetch(new Request('https://hub/enroll',{method:'POST',body:JSON.stringify({claim})}))
    if(!response.ok)return response
    return json({token:await sign(claim,env.DEVICE_AUTH_SECRET),accountId:account,expires:claim.expires})
   }
   let claim:DeviceClaim
   try{claim=await verify(bearer(request),env.DEVICE_AUTH_SECRET)}catch(e){return json({error:(e as Error).message},401)}
   const payload=request.method==='GET'?{}:await body(request)
   const stub=env.REMINDERS.get(env.REMINDERS.idFromName(claim.account))
   return await stub.fetch(new Request('https://hub'+route,{method:'POST',body:JSON.stringify({claim,method:request.method,payload})}))
  }catch{return json({error:'通知请求未能完成，请稍后重试'},400)}
 }
}
interface Device {nonce:string;expires:number;subscription:PushSubscription|null;createdAt:number;testAt:number}
type Delivery = {device:string;key:string;status:string;attempts:number;next:number}
export class ReminderHub {
 constructor(private ctx:DurableObjectState,private env:Env){
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS ops (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS deliveries (device TEXT, key TEXT, status TEXT, attempts INTEGER, next REAL, PRIMARY KEY(device,key))')
 }
 private devices(){return this.ctx.storage.sql.exec<{id:string;value:string}>('SELECT * FROM devices').toArray().map(r=>({id:r.id,...JSON.parse(r.value) as Device}))}
 private saveDevice(id:string,d:Device){this.ctx.storage.sql.exec('INSERT OR REPLACE INTO devices VALUES (?,?)',id,JSON.stringify(d))}
 private operations(){return this.ctx.storage.sql.exec<{value:string}>('SELECT value FROM ops').toArray().map(r=>JSON.parse(r.value) as Operation)}
 private deliveries(){return new Map(this.ctx.storage.sql.exec<Delivery>('SELECT * FROM deliveries').toArray().map(d=>[d.device+'/'+d.key,d]))}
 private due(now=Date.now()){
  const schedule=reminderSchedule(this.operations()),deliveries=this.deliveries()
  return this.devices().filter(d=>d.subscription&&d.expires>now).flatMap(d=>schedule.flatMap(r=>{
   const delivered=deliveries.get(d.id+'/'+r.key)
   if(r.at<d.createdAt-60000||r.at+900000<now||delivered?.status==='sent'||delivered?.status==='failed')return []
   return [{device:d,reminder:r,next:Math.max(r.at,delivered?.next??0),attempts:delivered?.attempts??0}]
  })).sort((a,b)=>a.next-b.next)
 }
 private async schedule(){const next=this.due()[0]?.next;if(next!==undefined)await this.ctx.storage.setAlarm(Math.max(Date.now()+100,next));else await this.ctx.storage.deleteAlarm()}
 async fetch(request:Request):Promise<Response>{return this.ctx.blockConcurrencyWhile(async()=>{
  try{
   const {claim,method,payload}=await request.json() as {claim:DeviceClaim;method:string;payload:any}
   const path=new URL(request.url).pathname
   const old=this.devices().find(d=>d.id===claim.device)
   if(path==='/enroll'){
    if(!old&&this.devices().length>=20)return json({error:'通知设备超过 20 台'},409)
    this.saveDevice(claim.device,{nonce:claim.nonce,expires:claim.expires,subscription:old?.subscription??null,createdAt:old?.createdAt??Date.now(),testAt:old?.testAt??0});await this.schedule();return json({ok:true})
   }
   if(!old||old.nonce!==claim.nonce||old.expires<=Date.now())return json({error:'通知设备已失效，请重新关联'},401)
   if(path==='/device'&&method==='DELETE'){
    this.ctx.storage.sql.exec('DELETE FROM devices WHERE id=?',claim.device);this.ctx.storage.sql.exec('DELETE FROM deliveries WHERE device=?',claim.device);await this.schedule();return json({ok:true})
   }
   if(path==='/state'&&method==='PUT'){
    validateProjection(payload.operations)
    const existing=this.operations(),byId=new Map(existing.map(o=>[o.id,o]))
    if(existing.length+payload.operations.filter((o:Operation)=>!byId.has(o.id)).length>20000)return json({error:'提醒日志超过上限，请联系维护'},413)
    // Validate the entire batch before any mutation. Replay is idempotent.
    for(const op of payload.operations as Operation[]){const prev=byId.get(op.id);if(prev&&canonical(prev)!==canonical(op))return json({error:'提醒日志编号冲突'},409)}
    this.ctx.storage.transactionSync(()=>{for(const op of payload.operations as Operation[])if(!byId.has(op.id))this.ctx.storage.sql.exec('INSERT INTO ops VALUES (?,?)',op.id,JSON.stringify(op))})
    // Keep historical operations for causal cancellation; prune only obsolete delivery receipts.
    this.ctx.storage.sql.exec('DELETE FROM deliveries WHERE next < ?',Date.now()-30*86400000)
    await this.schedule();return json({ok:true,scheduled:reminderSchedule(this.operations()).filter(r=>r.at>Date.now()).length})
   }
   if(path==='/subscription'&&['PUT','DELETE'].includes(method)){
    const value=method==='PUT'?subscription(payload.subscription):null
    const changed=old.subscription?.endpoint!==value?.endpoint
    if(value)for(const device of this.devices())if(device.id!==claim.device&&device.subscription?.endpoint===value.endpoint)this.saveDevice(device.id,{...device,subscription:null})
    this.saveDevice(claim.device,{...old,subscription:value,createdAt:changed?Date.now():old.createdAt})
    await this.schedule();return json({ok:true})
   }
   if(path==='/test'&&method==='POST'){
    if(!old.subscription)return json({error:'请先开启此设备的通知'},409)
    if(Date.now()-old.testAt<30000)return json({error:'请稍等 30 秒再发送测试通知'},429)
    this.saveDevice(claim.device,{...old,testAt:Date.now()})
    const status=await sendPush(this.env,old.subscription,{title:'LifeOS Pocket',body:'通知已连接，计划到时会在这里提醒。',tag:'lifeos-test'})
    if([404,410].includes(status)){this.saveDevice(claim.device,{...old,subscription:null});await this.schedule()}
    return status>=200&&status<300?json({ok:true}):json({error:'推送服务未接受测试通知，请重新开启通知'},502)
   }
   if(path==='/status'&&method==='GET')return json({subscribed:!!old.subscription,scheduled:this.due().filter(r=>r.device.id===claim.device).length})
   return json({error:'Method not allowed'},405)
  }catch(e){return json({error:e instanceof Error?e.message:'通知数据无效'},400)}
 })}
 async alarm(){await this.ctx.blockConcurrencyWhile(async()=>{
  await Promise.all(this.due().filter(t=>t.next<=Date.now()).slice(0,5).map(async task=>{
   const {device,reminder,attempts}=task
   // Persist a short lease before network I/O. A retry uses the same tag/topic.
   this.ctx.storage.sql.exec('INSERT OR REPLACE INTO deliveries VALUES (?,?,?,?,?)',device.id,reminder.key,'pending',attempts+1,Date.now()+60000)
   let status=0
   try{status=await sendPush(this.env,device.subscription!,{title:reminder.title,body:reminder.message??'计划时间到了',id:reminder.id,tag:'plan-'+reminder.key})}catch{}
   if([404,410].includes(status))this.saveDevice(device.id,{...device,subscription:null})
   const ok=status>=200&&status<300,terminal=ok||attempts>=4||(status>=400&&status<500&&status!==429)
   this.ctx.storage.sql.exec('INSERT OR REPLACE INTO deliveries VALUES (?,?,?,?,?)',device.id,reminder.key,ok?'sent':terminal?'failed':'pending',attempts+1,Date.now()+Math.min(300000,30000*2**attempts))
  }))
  await this.schedule()
 })}
}
