import {z} from 'zod'
import {businessSchemas,commandEntity,isBusinessWrite,validateBusinessCommand,type BusinessTool} from '../../../lifeos/pocket/src/native-business-contracts'
import {validateRow,type Entity} from '../../../lifeos/pocket/src/model'
import {dayAt} from '../../../lifeos/pocket/src/time'
import {digest} from './util'
const hex=z.string().regex(/^[a-f0-9]{64}$/),file=z.string().regex(/^[a-f0-9]{32}\.(png|jpg|jpeg|webp|gif|pdf|txt|m4a|mp4|webm|ogg|wav)$/)
export function setupBusiness(ctx:DurableObjectState){
 ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS native_content (device TEXT,generation TEXT,entity TEXT,id TEXT,version TEXT,data TEXT,PRIMARY KEY(device,generation,entity,id))')
 ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS native_media (file TEXT PRIMARY KEY,sha TEXT,size INTEGER,mime TEXT,ready INTEGER)')
 ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS native_chunk (file TEXT,part INTEGER,data TEXT,PRIMARY KEY(file,part))')
}
export function clearBusiness(ctx:DurableObjectState,state:any){ctx.storage.transactionSync(()=>{for(const table of ['native_content','native_media','native_chunk'])ctx.storage.sql.exec('DELETE FROM '+table)});state.fullEpoch=crypto.randomUUID();for(const d of Object.values(state.devices) as any[]){delete d.activeGeneration;delete d.staging}}
function owners(state:any){return (Object.entries(state.devices) as [string,any][]).filter(([,d])=>d.expires>Date.now()&&d.policy.full&&d.activeGeneration)}
export function contentRows(ctx:DurableObjectState,state:any,entity?:string,id?:string){
 const map=new Map<string,any>()
 for(const [device,d] of owners(state)){
  let query='SELECT entity,id,version,data FROM native_content WHERE device=? AND generation=?';const binds:any[]=[device,d.activeGeneration]
  if(entity){query+=' AND entity=?';binds.push(entity)}if(id){query+=' AND id=?';binds.push(id)}
  for(const row of ctx.storage.sql.exec<any>(query,...binds)){const key=row.entity+':'+row.id,old=map.get(key),item={...row,data:JSON.parse(row.data),updated_version:row.version};map.set(key,old&&old.version!==row.version?{...old,conflict:true}:old??item)}
 }
 return [...map.values()]
}
function referenced(ctx:DurableObjectState,state:any,name:string){for(const [device,d] of owners(state))for(const r of ctx.storage.sql.exec<{data:string}>("SELECT data FROM native_content WHERE device=? AND generation=? AND entity='records' AND instr(data,?)>0",device,d.activeGeneration,name))if(JSON.parse(r.data).attachments?.some((a:any)=>a.file===name))return true;return false}
function attachmentNotes(ctx:DurableObjectState,state:any,name:string){const notes=new Map<string,any>();for(const [device,d] of owners(state))for(const r of ctx.storage.sql.exec<{id:string;version:string;data:string}>("SELECT id,version,data FROM native_content WHERE device=? AND generation=? AND entity='records' AND instr(data,?)>0",device,d.activeGeneration,name)){const record=JSON.parse(r.data);if(record.attachments?.some((a:any)=>a.file===name))notes.set(r.id+':'+r.version,{record_id:r.id,updated_version:r.version,title:record.title,body:record.body,deleted:record.deleted})}return [...notes.values()]}
const CHUNK=98304
const mimeFor=(name:string)=>name.endsWith('.webm')?'audio/webm':name.endsWith('.ogg')?'audio/ogg':name.endsWith('.wav')?'audio/wav':/\.(m4a|mp4)$/.test(name)?'audio/mp4':/\.(jpg|jpeg)$/.test(name)?'image/jpeg':name.endsWith('.png')?'image/png':name.endsWith('.gif')?'image/gif':name.endsWith('.webp')?'image/webp':name.endsWith('.pdf')?'application/pdf':'text/plain'
export async function deviceBusiness(ctx:DurableObjectState,state:any,device:any,input:any,path:string){
 if(!device.policy.full)throw Error('设备未开放完整业务内容')
 if(path==='/business'){
  const generation=hex.parse(input.generation)
  if(input.phase==='begin'){
   if(device.activeGeneration===generation)return {published:true,media_epoch:state.fullEpoch}
   const count=z.number().int().min(0).max(100000).parse(input.count)
   if(device.staging?.generation===generation&&device.staging.expires>Date.now()){const received=ctx.storage.sql.exec<{n:number}>('SELECT count(*) AS n FROM native_content WHERE device=? AND generation=?',input.device,generation).one().n;return {published:false,received,media_epoch:state.fullEpoch}}
   ctx.storage.sql.exec('DELETE FROM native_content WHERE device=? AND generation<>?',input.device,device.activeGeneration??'')
   device.staging={generation,count,captured:Date.now(),expires:Date.now()+1800000};return {published:false,media_epoch:state.fullEpoch}
  }
  if(!device.staging||device.staging.generation!==generation||device.staging.expires<Date.now())throw Error('上传阶段已过期，请重试')
  if(input.phase==='page'){
   const rows=z.array(z.object({entity:z.enum(['modules','records','routines','sessions','completions']),id:z.string().max(100),version:hex,data:z.record(z.string(),z.unknown())}).strict()).min(1).max(50).parse(input.rows)
   for(const r of rows){validateRow(r.entity as Entity,r.data);if(r.id!==r.data.id||await digest(r.data)!==r.version)throw Error('完整业务投影编号/版本校验失败')}
   const bytes=ctx.storage.sql.exec<{n:number}>('SELECT coalesce(sum(length(data)),0) AS n FROM native_content').one().n
   if(bytes+JSON.stringify(rows).length>64*1024*1024)throw Error('完整投影达到64MB免费存储保护上限，旧投影保留')
   ctx.storage.transactionSync(()=>{for(const r of rows)ctx.storage.sql.exec('INSERT OR REPLACE INTO native_content VALUES (?,?,?,?,?,?)',input.device,generation,r.entity,r.id,r.version,JSON.stringify(r.data))})
   device.staging.expires=Date.now()+1800000;return {saved:rows.length}
  }
  if(input.phase==='commit'){
   const count=ctx.storage.sql.exec<{n:number}>('SELECT count(*) AS n FROM native_content WHERE device=? AND generation=?',input.device,generation).one().n
   if(count!==device.staging.count)throw Error('完整业务投影尚未完整上传，旧投影仍可读取')
   device.activeGeneration=generation;device.fullUpdated=Date.now();device.fullCaptured=device.staging.captured;device.fullCount=count;delete device.staging
   return {published:true,count,media_epoch:state.fullEpoch}
  }
  throw Error('未知完整投影阶段')
 }
 const name=file.parse(input.file)
 if(!referenced(ctx,state,name))throw Error('附件不在当前授权记录中')
 if(input.phase==='status'){
  const sha=hex.parse(input.sha256),size=z.number().int().min(1).max(4194304).parse(input.size),mime=mimeFor(name)
  const old=ctx.storage.sql.exec<any>('SELECT * FROM native_media WHERE file=?',name).toArray()[0]
  if(old&&(old.sha!==sha||old.size!==size))throw Error('同名附件校验冲突，原文件未覆盖')
  if(!old)ctx.storage.sql.exec('INSERT INTO native_media VALUES (?,?,?,?,0)',name,sha,size,mime)
  const present=new Set(ctx.storage.sql.exec<{part:number}>('SELECT part FROM native_chunk WHERE file=?',name).toArray().map(r=>r.part))
  return {ready:!!old?.ready,missing:Array.from({length:Math.ceil(size/CHUNK)},(_,i)=>i).filter(i=>!present.has(i)),chunk_size:CHUNK}
 }
 const meta=ctx.storage.sql.exec<any>('SELECT * FROM native_media WHERE file=?',name).toArray()[0];if(!meta)throw Error('请先提交附件清单')
 if(input.phase==='chunk'){
  const index=z.number().int().min(0).max(Math.ceil(meta.size/CHUNK)-1).parse(input.index),data=z.string().max(131072).regex(/^[A-Za-z0-9+/]*={0,2}$/).parse(input.data)
  if(atob(data).length!==Math.min(CHUNK,meta.size-index*CHUNK))throw Error('附件分片长度无效')
  if(meta.ready)return {ready:true}
  const total=ctx.storage.sql.exec<{n:number}>('SELECT coalesce(sum(length(data)),0) AS n FROM native_chunk').one().n
  if(total+data.length>90*1024*1024)throw Error('附件达到64MB免费存储保护上限')
  ctx.storage.sql.exec('INSERT OR REPLACE INTO native_chunk VALUES (?,?,?)',name,index,data);return {saved:true}
 }
 if(input.phase==='commit'){
  const bytes=attachmentBytes(ctx,meta);const sha=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('')
  if(sha!==meta.sha)throw Error('附件SHA-256不一致，尚未发布')
  ctx.storage.sql.exec('UPDATE native_media SET ready=1 WHERE file=?',name);return {ready:true,sha256:sha}
 }
 throw Error('未知附件上传阶段')
}
function attachmentBytes(ctx:DurableObjectState,meta:any){
 const parts=ctx.storage.sql.exec<{part:number;data:string}>('SELECT part,data FROM native_chunk WHERE file=? ORDER BY part',meta.file).toArray()
 if(parts.length!==Math.ceil(meta.size/CHUNK)||parts.some((p,i)=>p.part!==i))throw Error('附件尚未完整上传')
 const bytes=new Uint8Array(meta.size);for(const p of parts)bytes.set(Uint8Array.from(atob(p.data),c=>c.charCodeAt(0)),p.part*CHUNK);return bytes
}
function b64(bytes:Uint8Array){let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s)}
export async function businessTool(ctx:DurableObjectState,state:any,input:any){
 const name=input.name as BusinessTool,args=businessSchemas[name].parse(input.args) as any
 if(!input.policy?.full||!input.scopes?.includes('lifeos:full'))return {error:'需要在LifeOS及OAuth授权页开启“完整业务访问（含录音）”，旧权限不会自动扩大。',code:'missing_scope',required_scope:'lifeos:full',reconnect_required:true}
 const freshness={scope:'所有业务日期，含可选回收站；不包括凭证或操作日志',devices:owners(state).map(([,d])=>({updated_at:d.fullUpdated,captured_at:d.fullCaptured,records:d.fullCount,upload_in_progress:!!d.staging})),complete:owners(state).length>0&&owners(state).every(([,d])=>!d.staging),warning:'仅前台设备发布的业务投影；其他设备可能尚未手动Drive同步'}
 if(name==='lifeos_list_content'||name==='lifeos_get_content'){
  let rows=contentRows(ctx,state,args.entity,args.id)
  if(name==='lifeos_get_content')return {...freshness,item:rows[0]??null}
  rows=rows.filter(r=>{if(!args.include_deleted&&(r.data.deleted||r.data.archived))return false;if(args.module_id&&r.data.module_id!==args.module_id)return false;const day=r.data.date??(r.entity==='sessions'?dayAt(Date.parse(r.data.startedAt),r.data.timeZone):undefined),end=r.entity==='sessions'?dayAt(Date.parse(r.data.endedAt??new Date().toISOString()),r.data.timeZone):day;return (!args.from||!end||end>=args.from)&&(!args.to||!day||day<=args.to)}).sort((a,b)=>a.id.localeCompare(b.id))
  return {...freshness,items:rows.slice(args.offset,args.offset+args.limit),total_count:rows.length,next_offset:args.offset+args.limit<rows.length?args.offset+args.limit:null}
 }
 if(name==='lifeos_list_attachments'){
  const records=contentRows(ctx,state,'records',args.record_id),map=new Map<string,any>()
  for(const r of records)for(const a of r.data.attachments??[]){const meta=ctx.storage.sql.exec<any>('SELECT file,sha AS sha256,size,mime,ready FROM native_media WHERE file=?',a.file).toArray()[0];const old=map.get(a.file);map.set(a.file,{...a,...meta,ready:!!meta?.ready,record_ids:[...(old?.record_ids??[]),r.id]})}
  const list=[...map.values()];return {...freshness,items:list.slice(args.offset,args.offset+args.limit),next_offset:args.offset+args.limit<list.length?args.offset+args.limit:null}
 }
 if(name==='lifeos_read_attachment'){
  if(!referenced(ctx,state,args.file))throw Error('附件不在当前授权记录中')
  const meta=ctx.storage.sql.exec<any>('SELECT * FROM native_media WHERE file=?',args.file).toArray()[0]
  if(!meta?.ready)return {status:'not_ready',file:args.file,message:'文件尚未从设备完整上传；请在原文件所在设备保持LifeOS前台联网，或先按原流程手动Drive同步下载录音到本机。原文件仍保存在设备。'}
  const bytes=attachmentBytes(ctx,meta),metadata={file:meta.file,mime:meta.mime,size:meta.size,sha256:meta.sha,attachment_notes:attachmentNotes(ctx,state,args.file),audio_understanding:'文件可读不代表聊天客户端已听懂或已转写'}
  if(args.format!=='chunk'){if(args.format==='audio'&&!meta.mime.startsWith('audio/'))throw Error('此附件不是录音');return {native_attachment:{...metadata,data:b64(bytes),format:args.format}}}
  const chunk=bytes.slice(args.offset,args.offset+args.length);return {...metadata,offset:args.offset,data:b64(chunk),byte_length:chunk.length,next_offset:args.offset+chunk.length<bytes.length?args.offset+chunk.length:null}
 }
 if(!isBusinessWrite(name))throw Error('未知业务工具')
 const entity=name==='lifeos_control_timer'&&args.action==='start'?(args.subject_kind==='routine'?'routines':'records'):commandEntity(name),id=name==='lifeos_set_routine_completion'?args.routine_id+'_'+args.date:name==='lifeos_control_timer'&&args.action==='start'?args.subject_id:args.id
 if(['__proto__','prototype','constructor'].includes(args.command_id))throw Error('命令编号无效')
 const hash=await digest([name,args]),old=state.commands[args.command_id];if(old){if(old.hash!==hash)throw Error('命令编号内容冲突');return old}
 const modifying=!name.startsWith('lifeos_create_'),row=id?contentRows(ctx,state,entity,id)[0]:undefined
 if(modifying&&(row?row.conflict||row.version!==args.expected_version:name!=='lifeos_set_routine_completion'||!!args.expected_version))return {status:'conflict',reason:'目标版本已过期或投影冲突，请重新读取。'}
 if(Object.keys(state.commands).length>=200)throw Error('命令队列达到200条保护上限')
 const command=validateBusinessCommand({protocol:'lifeos-native-v2',command_id:args.command_id,created_at:new Date().toISOString(),tool:name,args})
 if(new TextEncoder().encode(JSON.stringify(command)).length>65536)throw Error('单次业务命令超过64KB，请缩短正文或分批编辑')
 const queued={command_id:args.command_id,hash,command,status:modifying?'review':'queued',review:modifying,created_at:Date.now(),reminder_status:'not_confirmed',message:'queued/review不是已写入；修改/删除/计时控制须本机审核'};state.commands[args.command_id]=queued;return queued
}
