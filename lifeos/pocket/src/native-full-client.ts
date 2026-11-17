import type {PocketDatabase} from './database'
import {businessSnapshot} from './native-business'
import {isDesktop} from './bridge'
import {mediaDigest} from './media'
type API=(action:string,data:unknown)=>Promise<any>
export class FullBusinessClient {
 private confirmed=new Set<string>();private epoch='';private uploading?:Awaited<ReturnType<typeof businessSnapshot>>
 constructor(private db:PocketDatabase,private api:API){}
 reset(){this.confirmed.clear();this.epoch='';this.uploading=undefined}
 async publish(){
  const snapshot=this.uploading??await businessSnapshot(this.db);this.uploading=snapshot;const begin=await this.api('business',{phase:'begin',generation:snapshot.generation,count:snapshot.rows.length})
  if(begin.media_epoch!==this.epoch){this.epoch=begin.media_epoch;this.confirmed.clear()}
  if(!begin.published){
   let offset=begin.received??0,budget=8
   while(offset<snapshot.rows.length&&budget-->0){
    const page:any[]=[];let size=0
    while(offset<snapshot.rows.length&&page.length<50){const next=snapshot.rows[offset],length=new TextEncoder().encode(JSON.stringify(next)).length;if(length>220000)throw Error('一条业务记录超过传输上限，旧投影保留；请分段保存超长正文');if(page.length&&size+length>220000)break;page.push(next);size+=length;offset++}
    await this.api('business',{phase:'page',generation:snapshot.generation,rows:page})
   }
   if(offset<snapshot.rows.length)return '完整内容上传中 '+offset+'/'+snapshot.rows.length+'；旧投影仍可读，下次前台检查继续'
   await this.api('business',{phase:'commit',generation:snapshot.generation})
  }
  this.uploading=undefined
  const files=new Set(snapshot.rows.filter(r=>r.entity==='records').flatMap(r=>r.data.attachments.map((a:any)=>a.file)))
  let chunks=4,checked=0,pending=0,missing=0
  for(const file of files){
   if(this.confirmed.has(file))continue;if(checked++>=8||chunks<=0){pending++;continue}
   try{
    const asset=await this.asset(file);if(!asset){missing++;continue}
    const state=await this.api('media',{phase:'status',file,sha256:asset.sha256,size:asset.bytes.byteLength})
    if(state.ready){this.confirmed.add(file);continue}
    let sent=0
    for(const index of state.missing){if(chunks<=0)break;const part=new Uint8Array(asset.bytes).slice(index*state.chunk_size,(index+1)*state.chunk_size);let raw='';for(let i=0;i<part.length;i+=8192)raw+=String.fromCharCode(...part.subarray(i,i+8192));await this.api('media',{phase:'chunk',file,index,data:btoa(raw)});chunks--;sent++}
    if(sent===state.missing.length){await this.api('media',{phase:'commit',file});this.confirmed.add(file)}else pending++
   }catch{pending++}
  }
  return '完整业务已发布 '+snapshot.rows.length+' 项；附件已就绪 '+this.confirmed.size+'，待传 '+pending+'，本机缺少或超过4MB '+missing
 }
 private async asset(file:string):Promise<{bytes:ArrayBuffer;sha256:string}|undefined>{
  const local=await this.db.media.get(file);if(local)return local
  if(!isDesktop())return
  const response=await fetch('/attachments/'+encodeURIComponent(file),{signal:AbortSignal.timeout(10000)});if(!response.ok||Number(response.headers.get('Content-Length'))>4194304)return
  const reader=response.body?.getReader();if(!reader)return;const parts:Uint8Array[]=[];let size=0
  while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>4194304){await reader.cancel();return}parts.push(part.value)}
  if(!size)return;const bytes=new Uint8Array(size);let at=0;for(const p of parts){bytes.set(p,at);at+=p.length}
  return {bytes:bytes.buffer,sha256:await mediaDigest(bytes)}
 }
}
