import type { PocketDatabase } from './database'
import { uuid,iso,type LifeRecord } from './model'
export const MAX_AUDIO_BYTES=4*1024*1024
export const audioFile=/^[a-f0-9]{32}\.(?:m4a|mp4|webm|ogg|wav)$/
export interface MediaAsset {file:string;bytes:ArrayBuffer;mime:string;sha256:string;size:number;createdAt:string}
export interface RemoteMedia {key:string;accountId:string;file:string;fileId:string;sha256:string;confirmed:boolean}
export const audioMime=(file:string)=>file.endsWith('.webm')?'audio/webm':file.endsWith('.ogg')?'audio/ogg':file.endsWith('.wav')?'audio/wav':'audio/mp4'
export async function mediaDigest(bytes:Uint8Array){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource))].map(b=>b.toString(16).padStart(2,'0')).join('')}
export async function makeAudio(blob:Blob):Promise<MediaAsset>{
 if(!blob.size||blob.size>MAX_AUDIO_BYTES)throw Error('录音为空或超过 4MB，请重新录制较短的语音')
 const mime=blob.type.split(';')[0],ext=mime==='audio/mp4'?'m4a':mime==='audio/webm'?'webm':mime==='audio/ogg'?'ogg':mime==='audio/wav'?'wav':''
 if(!ext)throw Error('当前录音格式不受支持')
 const bytes=await blob.arrayBuffer()
 return {file:uuid()+'.'+ext,bytes,mime,sha256:await mediaDigest(new Uint8Array(bytes)),size:blob.size,createdAt:iso()}
}
export function referencedAudio(records:LifeRecord[]){return [...new Set(records.filter(r=>!r.deleted).flatMap(r=>r.attachments.map(a=>a.file).filter(f=>audioFile.test(f))))]}
export async function serializeMedia(asset:MediaAsset){
 const bytes=new Uint8Array(asset.bytes);let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192))
 return {file:asset.file,mime:asset.mime,sha256:asset.sha256,size:asset.size,createdAt:asset.createdAt,data:btoa(text)}
}
export async function deserializeMedia(value:unknown):Promise<MediaAsset>{
 const v=value as Awaited<ReturnType<typeof serializeMedia>>
 if(!v||!audioFile.test(v.file)||v.mime!==audioMime(v.file)||!Number.isSafeInteger(v.size)||v.size<1||v.size>MAX_AUDIO_BYTES||typeof v.data!=='string'||v.data.length>Math.ceil(MAX_AUDIO_BYTES/3)*4||typeof v.createdAt!=='string'||!Number.isFinite(Date.parse(v.createdAt)))throw Error('备份录音格式无效')
 const bytes=Uint8Array.from(atob(v.data),c=>c.charCodeAt(0))
 if(bytes.length!==v.size||await mediaDigest(bytes)!==v.sha256)throw Error('备份录音完整性校验失败')
 return {file:v.file,mime:v.mime,sha256:v.sha256,size:v.size,createdAt:v.createdAt,bytes:bytes.buffer}
}
export async function importMedia(asset:MediaAsset,db:PocketDatabase){
 const old=await db.media.get(asset.file);if(old&&old.sha256!==asset.sha256)throw Error('录音编号冲突，已有录音未覆盖')
 if(!old)await db.media.add(asset)
}
