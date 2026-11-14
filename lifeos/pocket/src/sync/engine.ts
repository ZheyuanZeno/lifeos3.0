import { type PocketDatabase } from '../database'
import { applyOperations,getIdentity } from '../repository'
import { iso,uuid,validateOperation,type Operation } from '../model'
import { SyncError,MAX_BATCH_BYTES,type SyncTransport,type OperationBatch,type RemoteFile,type CloudBatch } from './types'
import { syncAudio } from './media-sync'
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true})
export const canonical=(value:unknown):string=>JSON.stringify(order(value))
function order(value:unknown):unknown { if(Array.isArray(value))return value.map(order);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,order(v)]));return value }
export async function digest(bytes:Uint8Array){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource))].map(x=>x.toString(16).padStart(2,'0')).join('')}
function decodeBatch(bytes:Uint8Array,file:RemoteFile):OperationBatch {
  if(bytes.byteLength>MAX_BATCH_BYTES)throw new SyncError('云端操作批次过大，已停止合并','integrity')
  let value:OperationBatch;try{value=JSON.parse(decoder.decode(bytes))}catch{throw new SyncError('云端文件不是有效的操作批次','integrity')}
  if(value.protocol!==1||value.id!==file.batchId||typeof value.writerDeviceId!=='string'||!Array.isArray(value.operations)||!value.operations.length||value.operations.length>500)throw new SyncError('同步协议或批次内容不兼容','integrity')
  value.operations.forEach(validateOperation);return value
}
async function pendingOperations(db:PocketDatabase,accountId:string){
 const acks=new Set((await db.cloudAcks.where('accountId').equals(accountId).toArray()).map(a=>a.operationId))
 return (await db.operations.toArray()).filter(o=>!acks.has(o.id)).sort((a,b)=>a.clock-b.clock||a.deviceId.localeCompare(b.deviceId)||a.sequence-b.sequence)
}
export async function pendingCount(db:PocketDatabase,accountId?:string){return accountId?(await pendingOperations(db,accountId)).length:db.operations.count()}
const running=new WeakMap<PocketDatabase,Promise<void>>()
const crossTabLocks=new Map<string,Promise<void>>()
export function sync(db:PocketDatabase,transport:SyncTransport):Promise<void>{
 const current=running.get(db);if(current)return current
 const task=withCrossTabLock(db.name,()=>run(db,transport)).finally(()=>running.delete(db));running.set(db,task);return task
}
async function withCrossTabLock(name:string,fn:()=>Promise<void>){
 if(typeof navigator!=='undefined'&&navigator.locks)return navigator.locks.request('lifeos-drive-'+name,{mode:'exclusive',ifAvailable:true},lock=>{if(!lock)throw new SyncError('另一个窗口正在同步，请稍后重试','busy');return fn()})
 const prior=crossTabLocks.get(name);if(prior)throw new SyncError('另一个窗口正在同步，请稍后重试','busy')
 const task=fn().finally(()=>crossTabLocks.delete(name));crossTabLocks.set(name,task);return task
}
async function pull(db:PocketDatabase,transport:SyncTransport,forceFull=false){
 const accountId=transport.accountId,state=await db.cloudState.get(accountId),initial=forceFull||!state?.cursor
 const start=initial?await transport.startCursor():state!.cursor!
 const files=new Map<string,RemoteFile>(),seenPages=new Set<string>();let pageToken:string|undefined,nextCursor=start
 do{
  const page=initial?await transport.listAll(pageToken):await transport.listChanges(start,pageToken)
  for(const id of page.removedIds)if(await db.cloudFiles.get(accountId+'/'+id))throw new SyncError('云端操作历史被删除，本地记录仍完整保留；请先导出备份','remote-missing')
  for(const file of page.files)files.set(file.id,file)
  pageToken=page.nextPageToken;if(pageToken){if(seenPages.has(pageToken))throw new SyncError('云端分页游标重复','integrity');seenPages.add(pageToken)}
  if(page.cursor)nextCursor=page.cursor
 }while(pageToken)
 if(forceFull)for(const known of await db.cloudFiles.where('accountId').equals(accountId).toArray())if(!files.has(known.fileId))throw new SyncError('重新扫描发现云端操作历史缺失，本地记录仍完整保留；请先导出备份','remote-missing')
 const incoming:Operation[]=[],ackIds=new Set<string>(),confirmed:RemoteFile[]=[]
 for(const file of files.values()){
  const known=await db.cloudFiles.get(accountId+'/'+file.id)
  if(known?.digest===file.digest&&known.version===file.version)continue
  if(known&&known.digest!==file.digest)throw new SyncError('云端不可变批次被修改，已保留本地版本并停止合并','integrity')
  const bytes=await transport.readFile(file.id);if(!bytes)throw new SyncError('云端批次暂时缺失，请重试','remote-missing')
  if(await digest(bytes)!==file.digest)throw new SyncError('云端文件完整性校验失败','integrity')
  const batch=decodeBatch(bytes,file);incoming.push(...batch.operations);for(const op of batch.operations)ackIds.add(op.id);confirmed.push(file)
 }
 await db.transaction('rw',db.tables,async()=>{
  if(incoming.length)await applyOperations(incoming,db,false)
  for(const operationId of ackIds)await db.cloudAcks.put({key:accountId+'/'+operationId,accountId,operationId})
  for(const file of confirmed)await db.cloudFiles.put({key:accountId+'/'+file.id,accountId,fileId:file.id,digest:file.digest,version:file.version})
  await db.cloudState.put({...state,key:accountId,accountId,cursor:nextCursor})
 })
}
async function confirm(db:PocketDatabase,transport:SyncTransport,batch:CloudBatch){
 const bytes=encoder.encode(batch.body),existing=await transport.readFile(batch.fileId)
 if(existing){if(await digest(existing)!==batch.digest)throw new SyncError('云端文件编号冲突，未覆盖已有内容','integrity')}
 else{
  await transport.createFile(batch.fileId,bytes,batch.batchId,batch.digest)
  const uploaded=await transport.readFile(batch.fileId)
  if(!uploaded||await digest(uploaded)!==batch.digest)throw new SyncError('上传尚未通过完整性确认，将保留本地批次并重试','integrity')
 }
 await db.transaction('rw',[db.cloudAcks,db.cloudBatches],async()=>{
  for(const operationId of batch.operationIds)await db.cloudAcks.put({key:batch.accountId+'/'+operationId,accountId:batch.accountId,operationId})
  await db.cloudBatches.update(batch.key,{status:'confirmed'})
 })
}
async function push(db:PocketDatabase,transport:SyncTransport){
 for(const batch of await db.cloudBatches.where('[accountId+status]').equals([transport.accountId,'pending']).toArray())await confirm(db,transport,batch)
 for(;;){
  const pending=await pendingOperations(db,transport.accountId);if(!pending.length)return
  const owner=await getIdentity(db),batchId=uuid(),operations:Operation[]=[]
  let body=''
  for(const operation of pending.slice(0,100)){
   const candidate=canonical({protocol:1,id:batchId,writerDeviceId:owner.id,createdAt:iso(),operations:[...operations,{...operation,uploaded:0}]})
   if(encoder.encode(candidate).byteLength>MAX_BATCH_BYTES){if(!operations.length)throw new SyncError('单条记录超过同步批次上限，请先导出备份','quota');break}
   operations.push({...operation,uploaded:0});body=candidate
  }
  const fileId=await transport.allocateFileId(),batch:CloudBatch={key:transport.accountId+'/'+batchId,accountId:transport.accountId,fileId,batchId,digest:await digest(encoder.encode(body)),body,operationIds:operations.map(o=>o.id),status:'pending'}
  // Persist the preallocated ID before upload. A lost success response reuses this exact ID and body.
  await db.cloudBatches.add(batch);await confirm(db,transport,batch)
 }
}
async function run(db:PocketDatabase,transport:SyncTransport){
 try{
  try{await pull(db,transport)}catch(error){if(!(error instanceof SyncError)||error.code!=='cursor')throw error;await pull(db,transport,true)}
  await syncAudio(db,transport);await push(db,transport);await db.cloudState.update(transport.accountId,{lastSuccessAt:iso(),lastError:undefined})
 }
 catch(error){await db.cloudState.put({...await db.cloudState.get(transport.accountId),key:transport.accountId,accountId:transport.accountId,lastError:error instanceof Error?error.message:'同步失败'});throw error}
}
