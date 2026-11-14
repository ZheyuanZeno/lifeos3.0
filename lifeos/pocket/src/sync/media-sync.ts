import type { PocketDatabase } from '../database'
import { audioMime,MAX_AUDIO_BYTES,mediaDigest,referencedAudio,importMedia } from '../media'
import { iso } from '../model'
import { SyncError,type SyncTransport } from './types'
export async function syncAudio(db:PocketDatabase,transport:SyncTransport){
 const files=referencedAudio(await db.records.toArray())
 if(!files.length)return
 if(!transport.findAudio||!transport.createAudio)throw new SyncError('当前同步服务不支持录音，语音仍保存在本地','permission')
 for(const file of files){
  const asset=await db.media.get(file),key=transport.accountId+'/'+file,known=await db.remoteMedia.get(key)
  if(asset&&known?.confirmed&&known.sha256===asset.sha256)continue
  if(!asset){
   const remote=await transport.findAudio(file)
   if(!remote)throw new SyncError('云端录音尚未上传完成，请先在录音设备同步后重试','remote-missing')
   if(remote.mime!==audioMime(file)||remote.size<1||remote.size>MAX_AUDIO_BYTES)throw new SyncError('云端录音格式或大小无效','integrity')
   const bytes=await transport.readFile(remote.id)
   if(!bytes||bytes.length!==remote.size||await mediaDigest(bytes)!==remote.sha256)throw new SyncError('云端录音完整性校验失败','integrity')
   await db.transaction('rw',[db.media,db.remoteMedia],async()=>{
    await importMedia({file,mime:remote.mime,size:bytes.length,sha256:remote.sha256,createdAt:iso(),bytes:bytes.slice().buffer as ArrayBuffer},db)
    await db.remoteMedia.put({key,accountId:transport.accountId,file,fileId:remote.id,sha256:remote.sha256,confirmed:true})
   });continue
  }
  const remote=await transport.findAudio(file)
  if(remote&&(remote.sha256!==asset.sha256||remote.size!==asset.size||remote.mime!==asset.mime))throw new SyncError('云端录音编号冲突，本地录音已保留','integrity')
  const fileId=known?.fileId??remote?.id??await transport.allocateFileId()
  await db.remoteMedia.put({key,accountId:transport.accountId,file,fileId,sha256:asset.sha256,confirmed:false})
  const bytes=new Uint8Array(asset.bytes),existing=await transport.readFile(fileId)
  if(!existing)await transport.createAudio(fileId,bytes,file,asset.mime,asset.sha256)
  const confirmed=existing??await transport.readFile(fileId)
  if(!confirmed||confirmed.length!==asset.size||await mediaDigest(confirmed)!==asset.sha256)throw new SyncError('录音上传尚未通过校验，将保留本地录音并重试','integrity')
  await db.remoteMedia.update(key,{confirmed:true})
 }
}
