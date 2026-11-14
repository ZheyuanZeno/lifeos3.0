import type { PocketDatabase } from './database'
import { audioMime,MAX_AUDIO_BYTES,mediaDigest,referencedAudio,importMedia } from './media'
import { iso } from './model'
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
