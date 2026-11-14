import type {PocketDatabase} from '../database'
import type {Operation} from '../model'
import type {DriveController} from '../sync/controller'
import {projectReminders,MAX_OPERATIONS} from './projection'

interface Credential {token:string;accountId:string;expires:number}
export class NotificationController {
 ready=false;busy=false;enabled=false;status='正在检查通知服务…';error=''
 private publicKey='';private registration?:ServiceWorkerRegistration;private credential?:Credential
 private initialized=false;private serviceReady=false;private running=false;private again=false;private timer?:ReturnType<typeof setTimeout>
 private lastSent='';private latest:Operation[]=[];private retry=0;private unsupported='';private subscriptionChecked=false
 constructor(private db:PocketDatabase,private drive:DriveController,private deviceId:()=>string,private changed:()=>void){
  window.addEventListener('online',()=>this.schedule());document.addEventListener('visibilitychange',()=>{if(!document.hidden)this.schedule()})
 }
 private emit(){this.changed()}
 private async localSubscription(){
  // A subscription cannot be active without permission. Avoid querying native push
  // services before consent; some WebKit runtimes stall on that call.
  return this.registration&&Notification.permission==='granted'?this.registration.pushManager.getSubscription():null
 }
 private async api(path:string,method='GET',data?:unknown,token=this.credential?.token){
  const response=await fetch('/api/notify/'+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined,cache:'no-store',signal:AbortSignal.timeout(15000)})
  const payload=await response.json() as Record<string,any>
  if(!response.ok){if(response.status===401&&token===this.credential?.token){this.credential=undefined;this.lastSent='';await this.db.local.delete('notificationCredential')};throw Error(payload.error??'通知服务暂时不可用')}
  return payload
 }
 async init(){
  try{
   const ios=/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1)
   const installed=matchMedia('(display-mode: standalone)').matches||!!(navigator as Navigator&{standalone?:boolean}).standalone
   if(!window.isSecureContext||!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window)||ios&&!installed){
    this.unsupported=ios?'请先在 Safari 中将 Pocket 添加到主屏幕，再从主屏幕打开通知。':'当前浏览器不支持系统推送通知'
   }
   this.credential=(await this.db.local.get('notificationCredential'))?.value as Credential|undefined
   const config=await this.api('config')
   if(!config.ready){this.status='通知服务尚未启用';return}
   this.publicKey=config.publicKey
   this.serviceReady=true
   if(!this.unsupported){this.registration=await navigator.serviceWorker.ready;this.enabled=!!await this.localSubscription();this.ready=true}
   this.status=this.unsupported||(this.enabled?'通知已开启':'通知未开启')
  }catch{this.status='通知服务暂时不可用，联网后可重试'}
  finally{this.initialized=true;this.emit();this.schedule()}
 }
 schedule(operations?:Operation[]){
  if(operations)this.latest=operations
  if(!this.initialized||!this.serviceReady)return
  clearTimeout(this.timer);this.timer=setTimeout(()=>void this.publish(),650)
 }
 private async associate(){
  const account=this.drive.accountId
  if(this.drive.state.connecting)return false
  if(!account){this.status=this.unsupported||'先连接一次 Google，即可关联通知设备';return false}
  if(this.credential?.accountId!==account&&this.credential){
   await this.api('device','DELETE',{})
   const sub=await this.localSubscription();await sub?.unsubscribe()
   this.credential=undefined;this.enabled=false;this.lastSent='';this.subscriptionChecked=false;await this.db.local.delete('notificationCredential')
  }
  if(this.credential&&this.credential.expires<=Date.now()){this.credential=undefined;this.lastSent='';await this.db.local.delete('notificationCredential')}
  if(!this.credential){
   if(!this.drive.authorization.connected){this.status='先连接一次 Google，即可关联通知设备';return false}
   const next=await this.api('enroll','POST',{deviceId:this.deviceId()},this.drive.authorization.token()) as unknown as Credential
   if(next.accountId!==account)throw Error('通知账号与当前同步账号不一致，请重连 Google')
   this.credential=next;await this.db.local.put({key:'notificationCredential',value:next})
   const sub=await this.localSubscription()
   if(sub)await this.api('subscription','PUT',{subscription:sub.toJSON()})
  }
  if(this.registration&&!this.subscriptionChecked){
   const remote=await this.api('status'),local=await this.localSubscription()
   if(local&&!remote.subscribed){this.enabled=false;this.status='通知订阅需要重新开启'}
   else if(!local&&remote.subscribed){await this.api('subscription','DELETE',{});this.enabled=false}
   this.subscriptionChecked=true
  }
  return true
 }
 private async upload(){
  const operations=projectReminders(this.latest),serialized=JSON.stringify({operations})
  if(operations.length>MAX_OPERATIONS||new TextEncoder().encode(serialized).length>2*1024*1024)throw Error('提醒日志超过容量限制，请联系维护')
  if(serialized!==this.lastSent){await this.api('state','PUT',{operations});this.lastSent=serialized}
 }
 private async publish(){
  if(this.running||this.busy){this.again=true;return}
  if(!navigator.onLine){this.status='离线，提醒变更待上传';this.emit();return}
  this.running=true
  try{
   if(await this.associate()){
    await this.upload();this.retry=0;this.error='';this.status=this.unsupported||(this.enabled?'通知已开启，提醒安排已更新':'通知未开启')
   }
  }catch(e){this.error=e instanceof Error?e.message:'提醒变更未上传';this.status='提醒变更未上传';clearTimeout(this.timer);this.timer=setTimeout(()=>void this.publish(),Math.min(60000,3000*2**this.retry++))}
  finally{this.running=false;this.emit();if(this.again){this.again=false;this.schedule()}}
 }
 // subscribe() must run directly in the click gesture, before any network await (iOS).
 async enable(){
  if(!this.ready||!this.registration)throw Error(this.unsupported||this.status)
  if(this.busy||this.running)throw Error('通知正在更新，请稍后再试')
  if(!this.credential||this.credential.accountId!==this.drive.accountId)throw Error('请先连接 Google，等待通知设备关联完成')
  const bytes=Uint8Array.from(atob(this.publicKey.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0))
  const subscribing=this.registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes})
  this.busy=true;this.error='';this.emit()
  try{
   const sub=await subscribing
   await this.upload();await this.api('subscription','PUT',{subscription:sub.toJSON()});this.enabled=true;this.status='通知已开启，提醒安排已更新'
  }catch(e){this.error=e instanceof DOMException&&e.name==='NotAllowedError'?'通知权限未开启，请在系统设置中允许 Pocket 通知':e instanceof Error?e.message:'通知未能开启';throw Error(this.error)}
  finally{this.busy=false;this.emit();this.schedule()}
 }
 async disable(){
  if(this.busy||this.running)throw Error('通知正在更新，请稍后再试')
  this.busy=true;this.error='';this.emit()
  try{
   if(this.credential)await this.api('subscription','DELETE',{})
   const sub=await this.localSubscription();await sub?.unsubscribe();this.enabled=false;this.status='通知已关闭'
  }catch(e){this.error=e instanceof Error?e.message:'通知未能关闭';throw e}
  finally{this.busy=false;this.emit()}
 }
 async test(){if(this.busy||this.running)throw Error('通知正在更新，请稍后再试');this.busy=true;this.emit();try{await this.api('test','POST',{});return '测试通知已交给推送服务'}finally{this.busy=false;this.emit()}}
 get canEnable(){return this.ready&&!!this.credential&&this.credential.accountId===this.drive.accountId&&!this.busy&&!this.running}
 get working(){return this.busy||this.running}
}
