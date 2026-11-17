import type {PocketDatabase} from '../database'
import {importMedia,type MediaAsset} from '../media'
import {iso,uuid} from '../model'
import {fromBase64,toBase64,signedHeaders,type SyncIdentity} from './identity'
import {canonical,digest} from './protocol'
import {SyncError,type SyncTransport,type RemotePage} from './types'

export interface SyncManifest {operation_count:number;operation_ids_digest:string;media_count:number;media_digest:string}
export interface SyncStatus {head:number;mode:'staging'|'active';manifest:SyncManifest;archive:null|{cursor:number;last_success?:string|null};unarchived_batches:number;bytes:number;limit_bytes:number;devices:{id:string;label:string;role:string;kind:string;revoked:number;cursor:number}[]}
interface Change {seq:number;kind:'batch'|'media';id:string;batch_id?:string;digest?:string;file?:string;sha?:string;size?:number;mime?:string}
export const attachmentFile=/^[a-f0-9]{32}\.(?:png|jpg|jpeg|webp|gif|pdf|txt|m4a|mp4|webm|ogg|wav)$/
const CHUNK=98304,MAX_MEDIA=32*1024*1024
export class CloudflareSyncTransport implements SyncTransport {
 readonly accountId:string
 private fullHead=0
 private roundHead?:number
 constructor(readonly identity:SyncIdentity,readonly endpoint='/api/sync',private fetcher:typeof fetch=(...args)=>fetch(...args)){this.accountId='cf-sync-v1:'+identity.spaceId}
 async request<T=any>(action:string,value:unknown={}):Promise<T>{
  const body=JSON.stringify(value),headers=await signedHeaders(this.identity,action,body)
  let response:Response
  try{response=await this.fetcher(this.endpoint+'/'+action,{method:'POST',headers,body,signal:AbortSignal.timeout(30000)})}catch{throw new SyncError('同步服务暂时不可达，本机修改已保留','network')}
  let result:any;try{result=await response.json()}catch{throw new SyncError('同步服务响应无效','network')}
  if(!response.ok){const code=response.status===401?'auth':response.status===403?'permission':response.status===507?'quota':result.code==='integrity'?'integrity':'network';throw new SyncError(result.error??'同步请求失败',code)}
  return result as T
 }
 status(){return this.request<SyncStatus>('status')}
 async allocateFileId(){return uuid()}
 async startCursor(){this.fullHead=(await this.status()).head;this.roundHead=this.fullHead;return String(this.fullHead)}
 private async page(after:number,until:number):Promise<RemotePage>{
  if(after===until)return {files:[],removedIds:[],cursor:String(until)}
  const page=await this.request<{items:Change[];next_after:number|null;until:number}>('changes',{after,until,kind:'batch',limit:50})
  return {files:page.items.map(c=>({id:c.id,batchId:c.batch_id!,digest:c.digest!,version:String(c.seq)})),removedIds:[],nextPageToken:page.next_after===null?undefined:until+':'+page.next_after,cursor:String(until)}
 }
 async listAll(token?:string){const [until,after]=token?token.split(':').map(Number):[this.fullHead,0];return this.page(after,until)}
 async listChanges(cursor:string,token?:string){const [until,after]=token?token.split(':').map(Number):[(await this.status()).head,Number(cursor)];this.roundHead=until;return this.page(after,until)}
 async readFile(id:string){const row=await this.request<{data:string;digest:string}|null>('batch/get',{file_id:id});if(!row)return null;const bytes=fromBase64(row.data);if(await digest(bytes)!==row.digest)throw new SyncError('云端批次校验失败','integrity');return bytes}
 async createFile(id:string,bytes:Uint8Array,batchId:string,sha:string){await this.request('batch/put',{file_id:id,batch_id:batchId,digest:sha,data:toBase64(bytes)})}
 async downloadMedia(file:string):Promise<MediaAsset>{
  const row=await this.request('media/status',{file});if(!row?.ready||row.size<1||row.size>MAX_MEDIA)throw new SyncError('历史媒体尚未完整到达云端','integrity')
  const bytes=new Uint8Array(row.size)
  for(let part=0;part<Math.ceil(row.size/CHUNK);part++){const chunk=await this.request('media/get',{file,part});if(!chunk)throw new SyncError('媒体分片缺失','integrity');const data=fromBase64(chunk.data);if(data.length!==Math.min(CHUNK,row.size-part*CHUNK))throw new SyncError('媒体分片长度不符','integrity');bytes.set(data,part*CHUNK)}
  if(await digest(bytes)!==row.sha)throw new SyncError('媒体校验失败，未保存损坏文件','integrity')
  return {file,bytes:bytes.buffer,size:row.size,mime:row.mime,sha256:row.sha,createdAt:iso()}
 }
 async uploadMedia(asset:MediaAsset){
  const bytes=new Uint8Array(asset.bytes);if(!attachmentFile.test(asset.file)||bytes.length!==asset.size||!bytes.length||bytes.length>MAX_MEDIA||await digest(bytes)!==asset.sha256)throw new SyncError('本机媒体校验失败，原文件已保留','integrity')
  let row=await this.request('media/status',{file:asset.file})
  if(row&&(row.sha!==asset.sha256||row.size!==asset.size||row.mime!==asset.mime))throw new SyncError('同名媒体内容冲突，原文件已保留','integrity')
  if(!row)row=await this.request('media/begin',{file:asset.file,file_id:asset.file.replace('.','_'),sha256:asset.sha256,size:asset.size,mime:asset.mime})
  if(row.ready)return
  for(const part of row.missing as number[])await this.request('media/put',{file:asset.file,part,data:toBase64(bytes.subarray(part*CHUNK,Math.min(bytes.length,(part+1)*CHUNK)))})
  await this.request('media/commit',{file:asset.file})
  const verified=await this.downloadMedia(asset.file);if(verified.sha256!==asset.sha256)throw new SyncError('媒体上传回读校验失败','integrity')
 }
 async syncMedia(db:PocketDatabase){
  const state=await db.cloudState.get(this.accountId),until=this.roundHead??(await this.status()).head;this.roundHead=undefined;let after=Number(state?.mediaCursor??0)
  while(after<until){const page=await this.request<{items:Change[];next_after:number|null}>('changes',{after,until,kind:'media',limit:50})
   for(const item of page.items){const old=await db.media.get(item.file!);if(old&&old.sha256!==item.sha)throw new SyncError('媒体历史内容冲突','integrity');if(!old)await importMedia(await this.downloadMedia(item.file!),db);await db.remoteMedia.put({key:this.accountId+'/'+item.file,accountId:this.accountId,file:item.file!,fileId:item.id,sha256:item.sha!,confirmed:true})}
   if(page.next_after===null)break;after=page.next_after
  }
  await db.cloudState.put({...await db.cloudState.get(this.accountId),key:this.accountId,accountId:this.accountId,mediaCursor:String(until)})
  // Include tombstones, old operation attachments and orphan media: phase 1 never prunes history.
  const required=new Set<string>()
  for(const row of await db.records.toArray())for(const a of row.attachments)required.add(a.file)
  for(const op of await db.operations.toArray())if(Array.isArray(op.patch.attachments))for(const a of op.patch.attachments)required.add(a.file)
  for(const file of required){if(!attachmentFile.test(file))throw new SyncError('历史附件名称无效','integrity');if(!await db.media.get(file))await importMedia(await this.downloadMedia(file),db)}
  const confirmed=new Set((await db.remoteMedia.where('accountId').equals(this.accountId).toArray()).filter(m=>m.confirmed).map(m=>m.file))
  for(const file of await db.media.toCollection().primaryKeys())if(!confirmed.has(file)){const asset=(await db.media.get(file))!;await this.uploadMedia(asset);await db.remoteMedia.put({key:this.accountId+'/'+file,accountId:this.accountId,file,fileId:file.replace('.','_'),sha256:asset.sha256,confirmed:true})}
 }
 async localManifest(db:PocketDatabase):Promise<SyncManifest>{
  const ids=(await db.operations.toArray()).map(o=>o.id).sort(),assets=await db.media.toArray()
  for(const asset of assets)if(asset.size!==asset.bytes.byteLength||await digest(new Uint8Array(asset.bytes))!==asset.sha256)throw new SyncError('本机历史媒体校验失败，不能正式迁移','integrity')
  const media=assets.map(m=>({file:m.file,sha:m.sha256})).sort((a,b)=>a.file.localeCompare(b.file))
  return {operation_count:ids.length,operation_ids_digest:await digest(new TextEncoder().encode(canonical(ids))),media_count:media.length,media_digest:await digest(new TextEncoder().encode(canonical(media)))}
 }
}
