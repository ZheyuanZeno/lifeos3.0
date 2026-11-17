import type {PocketDatabase} from '../database'
import {sync,pendingCount} from './engine'
import {CloudflareSyncTransport,type SyncStatus} from './cloudflare'
import {newSyncIdentity,saveSyncIdentity,randomId,type SyncIdentity} from './identity'
import {canonical,digest} from './protocol'
import {exportBackup} from '../repository'
import {SyncError} from './types'

export interface AutoSyncState {bound:boolean;active:boolean;working:boolean;pending:number;lastSuccessAt?:string;error:string;cloud?:SyncStatus}
const CONFIG='auto-sync-v1'
export class AutoSyncController {
 state:AutoSyncState={bound:false,active:false,working:false,pending:0,error:''}
 transport?:CloudflareSyncTransport
 private timer?:ReturnType<typeof setTimeout>
 private poll?:ReturnType<typeof setInterval>
 private running?:Promise<void>
 private dirty=false
 private failures=0
 private disposed=false
 private wake=()=>{if(!document.hidden&&navigator.onLine)this.schedule(0)}
 constructor(private db:PocketDatabase,private changed:()=>void,private makeTransport=(i:SyncIdentity)=>new CloudflareSyncTransport(i)){}
 async init(){
  const identity=(await this.db.local.get('sync-identity-v1'))?.value as SyncIdentity|undefined
  if(identity){this.transport=this.makeTransport(identity);this.state.bound=true;const config=(await this.db.local.get(CONFIG))?.value as {active?:boolean}|undefined;this.state.active=config?.active===true;this.state.lastSuccessAt=(await this.db.cloudState.get(this.transport.accountId))?.lastSuccessAt;await this.refreshPending()}
  window.addEventListener('online',this.wake);document.addEventListener('visibilitychange',this.wake);window.addEventListener('pageshow',this.wake)
  this.poll=setInterval(()=>{if(!document.hidden&&!this.timer)this.schedule(0)},45000)
  if(this.state.active)this.schedule(0);else if(this.transport&&navigator.onLine)void this.refreshStatus().catch(()=>{})
 }
 private emit(){if(!this.disposed)this.changed()}
 async refreshPending(){this.state.pending=this.transport?await pendingCount(this.db,this.transport.accountId):0;this.emit()}
 async refreshStatus(){if(!this.transport)return;try{this.state.cloud=await this.transport.status();if(this.state.cloud.mode==='active'&&!this.state.active){this.state.active=true;await this.db.local.put({key:CONFIG,value:{active:true}});this.schedule(0)}this.state.error='';this.emit()}catch(e){this.state.error=e instanceof Error?e.message:'同步服务不可达';this.emit();throw e}}
 changedLocally(){this.dirty=true;void this.refreshPending();this.schedule(1200)}
 private schedule(delay:number){if(this.disposed||!this.transport||!this.state.active||!navigator.onLine||document.hidden)return;if(this.timer)clearTimeout(this.timer);this.timer=setTimeout(()=>{this.timer=undefined;void this.syncNow().catch(()=>{})},delay)}
 syncNow():Promise<void>{if(this.running){this.dirty=true;return this.running}if(!this.transport)return Promise.resolve();this.running=this.run().finally(()=>{this.running=undefined});return this.running}
 private async run(){
  if(!navigator.onLine)return
  this.state.working=true;this.state.error='';this.emit();this.dirty=false
  try{
   await sync(this.db,this.transport!);await this.refreshStatus();const state=await this.db.cloudState.get(this.transport!.accountId),cursor=state?.cursor
   if(cursor&&cursor!==state?.acknowledgedCursor){await this.transport!.request('cursor/ack',{cursor:Number(cursor)});await this.db.cloudState.update(this.transport!.accountId,{acknowledgedCursor:cursor})}
   this.state.lastSuccessAt=(await this.db.cloudState.get(this.transport!.accountId))?.lastSuccessAt;this.failures=0;await this.refreshPending()
  }catch(e){this.failures++;this.state.error=e instanceof Error?e.message:'同步失败，本机修改已保留';this.schedule(Math.min(300000,2000*2**Math.min(this.failures,7))*(.75+Math.random()*.5));throw e}
  finally{this.state.working=false;this.emit();if(this.dirty)this.schedule(1200)}
 }
 async requestPair(spaceId:string,label:string){
  if(this.transport)throw Error('本机已经绑定，不能自动更换空间')
  if(!/^[a-f0-9]{64}$/.test(spaceId))throw Error('同步空间编号无效')
  const identity=await newSyncIdentity(spaceId,label),pair_id=randomId(),secret=randomId(),transport=this.makeTransport(identity)
  const result=await transport.request<{fingerprint:string;expires:number}>('pair/request',{pair_id,secret,public_key:identity.publicKey,label,kind:'pwa'})
  await this.db.local.put({key:'sync-pair-v1',value:{identity,pair_id,secret,expires:result.expires}})
  return {spaceId,pair_id,secret,fingerprint:result.fingerprint,expires:result.expires}
 }
 async claimPair(){
  const pairing=(await this.db.local.get('sync-pair-v1'))?.value as {identity:SyncIdentity;pair_id:string;secret:string;expires:number}|undefined
  if(!pairing||pairing.expires<Date.now())throw Error('配对请求已过期，请重新申请')
  const transport=this.makeTransport(pairing.identity),status=await transport.request<SyncStatus>('pair/claim',{pair_id:pairing.pair_id,secret:pairing.secret})
  await saveSyncIdentity(this.db,pairing.identity);await this.db.local.delete('sync-pair-v1');this.transport=transport;this.state.bound=true;this.state.cloud=status;await this.refreshStatus();this.emit()
 }
 async approvePair(value:{pair_id:string;secret:string;fingerprint:string},role:'member'|'owner'='member'){if(!this.transport)throw Error('请先绑定');return this.transport.request('pair/approve',{...value,role})}
 async recover(spaceId:string,recovery:string,label:string){
  if(this.transport)throw Error('请使用独立的新设备恢复，避免覆盖当前绑定')
  const identity=await newSyncIdentity(spaceId,label),transport=this.makeTransport(identity)
  await transport.request('recover',{recovery,public_key:identity.publicKey,label});await saveSyncIdentity(this.db,identity);this.transport=transport;this.state.bound=true;await this.refreshStatus()
 }
 async verifyMigration(sourceConfirmed:boolean,persistBackup:(backup:Awaited<ReturnType<typeof exportBackup>>,stage?:'before'|'verified')=>Promise<void>){
  if(!this.transport||!sourceConfirmed)throw Error('请先确认已完成最后一次旧渠道同步，并允许补传历史和媒体')
  const before=await exportBackup(this.db),beforeDigest=await digest(new TextEncoder().encode(canonical(before)))
  await persistBackup(before,'before')
  await this.transport.request('migration/prepare',{source_confirmed:true,backup_digest:beforeDigest})
  await this.syncNow()
  const backup=await exportBackup(this.db),backupDigest=await digest(new TextEncoder().encode(canonical(backup))),manifest=await this.transport.localManifest(this.db),cloud=await this.transport.status()
  if(canonical(manifest)!==canonical(cloud.manifest))throw Error('本机与云端完整历史清单不一致，不能正式切换')
  const changed=canonical({...before,exportedAt:''})!==canonical({...backup,exportedAt:''})
  if(changed)await persistBackup(backup,'verified')
  const verifiedDigest=changed?backupDigest:beforeDigest
  await this.transport.request('migration/verify',{head:cloud.head,manifest,backup_digest:verifiedDigest,source_confirmed:true});await this.refreshStatus()
  return {backup:changed?backup:before,backupDigest:verifiedDigest}
 }
 async activate(){if(!this.transport)throw Error('请先绑定');await this.transport.request('activate');await this.refreshStatus();this.schedule(0)}
 async disconnect(){
  if(this.running)throw Error('请等待当前同步结束')
  if(!this.transport)return
  try{await this.transport.request('device/revoke',{device_id:this.transport.identity.deviceId})}catch(e){if(!(e instanceof SyncError)||e.code!=='auth')throw e}
  if(this.timer)clearTimeout(this.timer)
  await this.db.transaction('rw',this.db.local,async()=>{await this.db.local.bulkDelete(['sync-identity-v1',CONFIG,'sync-pair-v1'])})
  this.transport=undefined;this.state={bound:false,active:false,working:false,pending:0,error:''};this.emit()
 }
 dispose(){this.disposed=true;if(this.timer)clearTimeout(this.timer);if(this.poll)clearInterval(this.poll);window.removeEventListener('online',this.wake);document.removeEventListener('visibilitychange',this.wake);window.removeEventListener('pageshow',this.wake)}
}
