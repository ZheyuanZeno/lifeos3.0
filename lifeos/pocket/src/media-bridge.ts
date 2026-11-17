import type { PocketDatabase } from './database'
import { audioMime,MAX_AUDIO_BYTES,MAX_MEDIA_BYTES,mediaFile,fileMime,mediaDigest,referencedAudio,importMedia } from './media'
import { iso } from './model'
/** Recover originals from the desktop, including attachments of tombstones and old operations. */
export async function recoverDesktopMedia(db:PocketDatabase,files:string[],fetcher:typeof fetch=(...args)=>fetch(...args)){
 if(typeof location==='undefined'||!['127.0.0.1','localhost'].includes(location.hostname))return
 for(const file of new Set(files)){
  if(!mediaFile.test(file))throw Error('历史附件名称无效')
  if(await db.media.where('file').equals(file).count())continue
  const response=await fetcher('/attachments/'+file,{cache:'no-store',signal:AbortSignal.timeout(20000)})
  if(response.status===404)continue
  if(!response.ok)throw Error('本机历史附件暂不可读取，请保留原文件并重试')
  const reader=response.body?.getReader();if(!reader)throw Error('本机历史附件内容为空')
  const chunks:Uint8Array[]=[];let size=0
  while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>MAX_MEDIA_BYTES){await reader.cancel();throw Error('本机历史附件超过 32MB，不能完整迁移')}chunks.push(part.value)}
  if(!size)throw Error('本机历史附件为空，不能完整迁移')
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
  await importMedia({file,bytes:bytes.buffer,mime:fileMime(file),size,sha256:await mediaDigest(bytes),createdAt:iso()},db)
 }
}
export async function uploadDesktopAudio(db:PocketDatabase,token:string){
 for(const file of referencedAudio(await db.records.toArray())){
  const asset=await db.media.get(file);if(!asset)continue
  if((await db.local.get('desktopAudio/'+location.origin+'/'+file))?.value===asset.sha256)continue
  const response=await fetch('/api/pocket/media/'+file,{method:'POST',headers:{'X-LifeOS-Token':token,'Content-Type':asset.mime},body:asset.bytes,signal:AbortSignal.timeout(20000)})
  if(!response.ok)throw Error('录音尚未写入本机白板，请重试（'+response.status+'）')
  const result=await response.json();if(result.sha256!==asset.sha256)throw Error('本机录音摘要不一致，未确认同步')
  await db.local.put({key:'desktopAudio/'+location.origin+'/'+file,value:asset.sha256})
 }
}
export async function downloadDesktopAudio(db:PocketDatabase){
 for(const file of referencedAudio(await db.records.toArray())){
  if(await db.media.get(file))continue
  const response=await fetch('/attachments/'+file,{cache:'no-store',signal:AbortSignal.timeout(20000)})
  if(!response.ok)throw Error('本机录音文件暂不可用，请先完成原设备的云端同步')
  const blob=await response.blob();if(!blob.size||blob.size>MAX_AUDIO_BYTES)throw Error('本机录音大小无效')
  const bytes=await blob.arrayBuffer(),asset={file,bytes,mime:audioMime(file),size:blob.size,sha256:await mediaDigest(new Uint8Array(bytes)),createdAt:iso()}
  await db.transaction('rw',db.media,async()=>importMedia(asset,db))
 }
}
