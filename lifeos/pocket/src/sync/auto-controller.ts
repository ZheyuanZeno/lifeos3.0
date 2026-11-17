import type {PocketDatabase} from '../database'
import {sync,pendingCount} from './engine'
import {CloudflareSyncTransport,type SyncStatus} from './cloudflare'
import {newSyncIdentity,saveSyncIdentity,randomId,type SyncIdentity} from './identity'
import {canonical,digest} from './protocol'
import {exportBackup} from '../repository'
import {SyncError} from './types'

export interface MigrationProgress {stage:'backup'|'prepare'|'sync'|'verify'|'complete'|'failed'|'interrupted'|'waiting';message:string;error?:string;backup?:'requested'|'reused';consented:boolean}
export interface AutoSyncState {bound:boolean;active:boolean;working:boolean;pending:number;lastSuccessAt?:string;error:string;cloud?:SyncStatus;migration?:MigrationProgress}
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
 private wizardTimer?:ReturnType<typeof setInterval>
 private wizardIntent=false
 private migrating=false
 private wake=()=>{if(!document.hidden&&navigator.onLine){if(this.wizardIntent&&!this.state.active)void this.resumeWizard();else this.schedule(0)}}
 constructor(private db:PocketDatabase,private changed:()=>void,private makeTransport=(i:SyncIdentity)=>new CloudflareSyncTransport(i)){}
 async init(){
  const identity=(await this.db.local.get('sync-identity-v1'))?.value as SyncIdentity|undefined
  if(identity){this.transport=this.makeTransport(identity);this.state.bound=true;const config=(await this.db.local.get(CONFIG))?.value as {active?:boolean}|undefined;this.state.active=config?.active===true;this.state.lastSuccessAt=(await this.db.cloudState.get(this.transport.accountId))?.lastSuccessAt;if(!this.state.active&&(await this.db.local.get(this.backupKey()))?.value)this.state.migration={stage:'interrupted',message:'备份已确认保存，点击继续开启同步。',backup:'reused',consented:true};await this.refreshPending()}
  window.addEventListener('online',this.wake);document.addEventListener('visibilitychange',this.wake);window.addEventListener('pageshow',this.wake)
  this.poll=setInterval(()=>{if(!document.hidden&&!this.timer)this.schedule(0)},45000)
  if(this.transport&&(await this.db.local.get('sync-wizard/'+this.transport.accountId))?.value===true){this.wizardIntent=true;this.startWizardPolling();void this.resumeWizard()}
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
 private backupKey(){return 'sync-migration-backup/'+this.transport!.accountId}
 private progress(stage:MigrationProgress['stage'],message:string){this.state.migration={...this.state.migration,stage,message,error:undefined,consented:true};this.emit()}
 private async migrationBackup(backup:Awaited<ReturnType<typeof exportBackup>>,stage:'before'|'verified',persistBackup:(backup:Awaited<ReturnType<typeof exportBackup>>,stage?:'before'|'verified')=>Promise<void>,reuseSource=false){
  const contentDigest=await digest(new TextEncoder().encode(canonical({...backup,exportedAt:''}))),saved=(await this.db.local.get(this.backupKey()))?.value as {contentDigest:string;digest:string;exportedAt:string}|undefined
  if(saved&&(reuseSource||saved.contentDigest===contentDigest)&&/^[a-f0-9]{64}$/.test(saved.digest)&&typeof saved.exportedAt==='string'){
   this.state.migration={...this.state.migration!,backup:'reused'};this.emit();return {backup:{...backup,exportedAt:saved.exportedAt},digest:saved.digest}
  }
  const hash=await digest(new TextEncoder().encode(canonical(backup)))
  await persistBackup(backup,stage)
  await this.db.local.put({key:this.backupKey(),value:{contentDigest,digest:hash,exportedAt:backup.exportedAt}})
  this.state.migration={...this.state.migration!,backup:'requested'};this.emit();return {backup,digest:hash}
 }
 async verifyMigration(sourceConfirmed:boolean,persistBackup:(backup:Awaited<ReturnType<typeof exportBackup>>,stage?:'before'|'verified')=>Promise<void>,automatic=false){
  if(!this.transport||!sourceConfirmed)throw Error('请先确认已完成最后一次旧渠道同步，并允许补传历史和媒体')
  if(this.migrating)return
  this.migrating=true
  this.state.error=''
  try{
   this.progress('backup','1/4 正在生成本机备份…')
   const before=await this.migrationBackup(await exportBackup(this.db),'before',persistBackup,automatic)
   if(automatic){await this.db.local.put({key:'sync-wizard/'+this.transport.accountId,value:true});this.wizardIntent=true;this.startWizardPolling()}
   this.progress('prepare','2/4 正在连接同步中心，申请补传…')
   await this.transport.request('migration/prepare',{source_confirmed:true,backup_digest:before.digest,...(automatic?{auto_activate:true}:{})})
   this.progress('sync','3/4 正在补传本机文件、读取其他设备的资料…')
   await this.syncNow()
   this.progress('verify','4/4 正在校验完整清单…')
   const backup=await exportBackup(this.db),manifest=await this.transport.localManifest(this.db),cloud=await this.transport.status()
   if(canonical(manifest)!==canonical(cloud.manifest))throw Error('本机与云端完整历史清单不一致，不能正式切换')
   const verified=automatic?before:await this.migrationBackup(backup,'verified',persistBackup)
   await this.transport.request('migration/verify',{head:cloud.head,manifest,backup_digest:verified.digest,source_confirmed:true});await this.refreshStatus()
   this.progress(automatic?'waiting':'complete',automatic?'本机已准备好。请在另一台手机也开启自动同步；电脑备份完成后会自动启用。':'本机清单已核验。下一步：另一台设备也完成迁移，电脑归档齐全后再正式切换。')
   return {backup:verified.backup,backupDigest:verified.digest}
  }catch(e){const reason=e instanceof Error?e.message:'迁移失败',step=this.state.migration?.message??'迁移';this.state.error=reason;const waiting=automatic&&e instanceof SyncError&&['remote-missing','network','busy'].includes(e.code);this.state.migration={...this.state.migration!,stage:waiting?'waiting':'failed',message:waiting?(e instanceof SyncError&&e.code==='remote-missing'?'还在等旧录音或附件。请在原设备也开启同步，原件到达后会自动继续。':'连接暂时未完成，保持 LifeOS 打开，稍后会自动重试。'):'迁移已暂停：'+step.replace(/…$/,''),error:reason};this.emit();throw e}
  finally{this.migrating=false}
 }
 private startWizardPolling(){if(!this.wizardTimer)this.wizardTimer=setInterval(()=>void this.resumeWizard(),15000)}
 private async resumeWizard(){
  if(this.disposed||this.migrating||!this.transport||!this.wizardIntent||!navigator.onLine||document.hidden)return
  try{await this.refreshStatus();if(this.state.active){if(this.wizardTimer)clearInterval(this.wizardTimer);this.wizardTimer=undefined;this.progress('complete','自动同步已开启，以后正常记录即可。');return}await this.verifyMigration(true,async()=>{throw Error('请先保存本机备份')},true)}catch{}
 }
 async activate(){if(!this.transport)throw Error('请先绑定');await this.transport.request('activate');await this.refreshStatus();this.schedule(0)}
 async disconnect(){
  if(this.running)throw Error('请等待当前同步结束')
  if(!this.transport)return
  try{await this.transport.request('device/revoke',{device_id:this.transport.identity.deviceId})}catch(e){if(!(e instanceof SyncError)||e.code!=='auth')throw e}
  if(this.timer)clearTimeout(this.timer)
  await this.db.transaction('rw',this.db.local,async()=>{await this.db.local.bulkDelete(['sync-identity-v1',CONFIG,'sync-pair-v1','sync-wizard/'+this.transport!.accountId])})
  this.wizardIntent=false;if(this.wizardTimer)clearInterval(this.wizardTimer);this.wizardTimer=undefined
  this.transport=undefined;this.state={bound:false,active:false,working:false,pending:0,error:''};this.emit()
 }
 dispose(){this.disposed=true;if(this.timer)clearTimeout(this.timer);if(this.poll)clearInterval(this.poll);if(this.wizardTimer)clearInterval(this.wizardTimer);window.removeEventListener('online',this.wake);document.removeEventListener('visibilitychange',this.wake);window.removeEventListener('pageshow',this.wake)}
}
