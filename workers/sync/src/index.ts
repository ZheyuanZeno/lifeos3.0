import {createHash} from 'node:crypto'
import {z} from 'zod'
import {validateOperation} from '../../../lifeos/pocket/src/model'
import {canonical} from '../../../lifeos/pocket/src/sync/protocol'
const enc=new TextEncoder(),hex=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),filename=z.string().regex(/^[a-f0-9]{32}\.(png|jpg|jpeg|webp|gif|pdf|txt|m4a|mp4|webm|ogg|wav)$/)
const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex'),b64=(v:Uint8Array)=>Buffer.from(v).toString('base64'),decode=(v:string)=>new Uint8Array(Buffer.from(v,'base64'))
const CHUNK=98304,LIMIT=768*1024*1024
class Fault extends Error{constructor(message:string,readonly status=400,readonly code='invalid'){super(message)}}
interface Env {SPACES:DurableObjectNamespace;LIMITER:DurableObjectNamespace;SYNC_CREATE_HASH?:string}
async function input(r:{body:ReadableStream<Uint8Array>|null}){const parts:Uint8Array[]=[];let size=0;const reader=r.body?.getReader();if(reader)while(true){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>2*1024*1024){await reader.cancel();throw new Fault('请求过大',413)}parts.push(p.value)}const bytes=new Uint8Array(size);let at=0;for(const p of parts){bytes.set(p,at);at+=p.length}const raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);return {raw,value:JSON.parse(raw||'{}')}}
const jwk=z.object({kty:z.literal('EC'),crv:z.literal('P-256'),x:z.string().regex(/^[\w-]{43}$/),y:z.string().regex(/^[\w-]{43}$/),ext:z.boolean().optional(),key_ops:z.array(z.string()).optional()}).strict()
async function verify(r:Request,raw:string,key:any,space:string,device:string,action:string){
 const timestamp=r.headers.get('X-LifeOS-Time')??'',nonce=r.headers.get('X-LifeOS-Nonce')??'',sig=r.headers.get('X-LifeOS-Signature')??''
 if(!/^\d{13}$/.test(timestamp)||Math.abs(Date.now()-Number(timestamp))>300000||!/^[a-f0-9]{32}$/.test(nonce)||sig.length>200)throw new Fault('签名时间或随机数无效，请检查系统时间',401,'auth')
 const envelope=JSON.stringify(['lifeos-sync-auth-v1',space,device,action,timestamp,nonce,hash(enc.encode(raw))]),publicKey=await crypto.subtle.importKey('jwk',jwk.parse(key),{name:'ECDSA',namedCurve:'P-256'},false,['verify'])
 if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},publicKey,decode(sig),enc.encode(envelope)))throw new Fault('设备签名无效',401,'auth')
 return {nonce,time:Number(timestamp)}
}
export class SyncLimiter {
 constructor(private ctx:DurableObjectState){ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY,count INTEGER,until INTEGER)')}
 async fetch(r:Request){const {key,max,window}=await r.json() as any,now=Date.now();let row=this.ctx.storage.sql.exec<any>('SELECT * FROM limits WHERE key=?',key).toArray()[0];if(!row||row.until<now)row={count:0,until:now+window};row.count++;this.ctx.storage.sql.exec('INSERT OR REPLACE INTO limits VALUES (?,?,?)',key,row.count,row.until);return Response.json({allowed:row.count<=max})}
}
export class SyncSpace {
 constructor(private ctx:DurableObjectState){for(const sql of [
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT)',
  'CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY,jwk TEXT,label TEXT,role TEXT,kind TEXT,revoked INTEGER DEFAULT 0,cursor INTEGER DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS nonces (device TEXT,nonce TEXT,time INTEGER,PRIMARY KEY(device,nonce))',
  'CREATE TABLE IF NOT EXISTS pairing (id TEXT PRIMARY KEY,secret_hash TEXT,device TEXT,jwk TEXT,label TEXT,kind TEXT,expires INTEGER,role TEXT,approved INTEGER DEFAULT 0,claimed INTEGER DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS changes (seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT,id TEXT UNIQUE)',
  'CREATE TABLE IF NOT EXISTS batches (file_id TEXT PRIMARY KEY,batch_id TEXT UNIQUE,digest TEXT,body BLOB,seq INTEGER)',
  'CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY,device TEXT,sequence INTEGER,digest TEXT,UNIQUE(device,sequence))',
  'CREATE TABLE IF NOT EXISTS media (file TEXT PRIMARY KEY,id TEXT UNIQUE,sha TEXT,size INTEGER,mime TEXT,ready INTEGER DEFAULT 0,seq INTEGER)',
  'CREATE TABLE IF NOT EXISTS chunks (file TEXT,part INTEGER,body BLOB,PRIMARY KEY(file,part))',
  'CREATE TABLE IF NOT EXISTS migration (device TEXT PRIMARY KEY,head INTEGER,manifest TEXT,backup_digest TEXT,confirmed INTEGER,time INTEGER)',
  'CREATE TABLE IF NOT EXISTS migration_preparations (device TEXT PRIMARY KEY,backup_digest TEXT,time INTEGER)'
 ])ctx.storage.sql.exec(sql)}
 private get(key:string,fallback:any=null){const row=this.ctx.storage.sql.exec<{value:string}>('SELECT value FROM meta WHERE key=?',key).toArray()[0];return row?JSON.parse(row.value):fallback}
 private put(key:string,value:any){this.ctx.storage.sql.exec('INSERT OR REPLACE INTO meta VALUES (?,?)',key,JSON.stringify(value))}
 private head(){return this.ctx.storage.sql.exec<{n:number}>('SELECT coalesce(max(seq),0) AS n FROM changes').one().n}
 private used(){return this.ctx.storage.sql.databaseSize}
 private nonce(device:string,v:{nonce:string;time:number}){if(this.ctx.storage.sql.exec('SELECT 1 FROM nonces WHERE device=? AND nonce=?',device,v.nonce).toArray().length)throw new Fault('拒绝重放请求',409,'replay');this.ctx.storage.sql.exec('DELETE FROM nonces WHERE time<?',Date.now()-600000);this.ctx.storage.sql.exec('INSERT INTO nonces VALUES (?,?,?)',device,v.nonce,v.time)}
 private manifest(){const head=this.head(),cached=this.get('manifest_cache');if(cached?.head===head)return cached.value;const operations=this.ctx.storage.sql.exec<{id:string}>('SELECT id FROM operations ORDER BY id').toArray().map(r=>r.id),media=this.ctx.storage.sql.exec<any>('SELECT file,sha FROM media WHERE ready=1 ORDER BY file').toArray();const value={operation_count:operations.length,operation_ids_digest:hash(canonical(operations)),media_count:media.length,media_digest:hash(canonical(media))};this.put('manifest_cache',{head,value});return value}
 private status(){const head=this.head(),archive=this.get('archive'),manifest=this.manifest();return {protocol:'lifeos-sync-v1',head,mode:this.get('mode','staging'),manifest,archive,unarchived_batches:this.ctx.storage.sql.exec<{n:number}>('SELECT count(*) AS n FROM batches WHERE seq>?',archive?.cursor??0).one().n,bytes:this.used(),limit_bytes:LIMIT,devices:this.ctx.storage.sql.exec('SELECT id,label,role,kind,revoked,cursor FROM devices').toArray(),migration_checks:this.ctx.storage.sql.exec('SELECT device,head,time,confirmed FROM migration').toArray(),migration_preparations:this.ctx.storage.sql.exec("SELECT p.device,p.time,1 AS confirmed FROM migration_preparations p JOIN devices d ON d.id=p.device WHERE d.revoked=0 AND d.kind='pwa'").toArray()}}
 async fetch(r:Request){return this.ctx.blockConcurrencyWhile(async()=>{try{
  const {raw,value:b}=await input(r),action=new URL(r.url).pathname.slice(1),space=hex.parse(r.headers.get('X-LifeOS-Space')),device=id.parse(r.headers.get('X-LifeOS-Device'))
  let owner=this.ctx.storage.sql.exec<any>('SELECT * FROM devices WHERE id=?',device).toArray()[0]
  if(action==='create'){
   const key=jwk.parse(b.public_key),proof=await verify(r,raw,key,space,device,action)
   if(this.get('space')){if(owner&&!owner.revoked&&owner.jwk===canonical(key)){this.nonce(device,proof);return Response.json(this.status())}throw new Fault('空间已存在',409)}
   hex.parse(b.recovery_hash);this.ctx.storage.transactionSync(()=>{this.put('space',space);this.put('recovery_hash',b.recovery_hash);this.put('mode','staging');this.ctx.storage.sql.exec('INSERT INTO devices(id,jwk,label,role,kind) VALUES (?,?,?,?,?)',device,canonical(key),String(b.label??'主设备').slice(0,80),'owner',b.kind==='archive'?'archive':'pwa');this.nonce(device,proof)});return Response.json(this.status())
  }
  if(!this.get('space'))throw new Fault('空间不存在或尚未创建',404,'auth')
  if(action==='pair/request'){
   const key=jwk.parse(b.public_key),proof=await verify(r,raw,key,space,device,action),pair=hex.parse(b.pair_id),secret=hex.parse(b.secret)
   if(this.ctx.storage.sql.exec<{n:number}>('SELECT count(*) AS n FROM pairing WHERE expires>? AND claimed=0',Date.now()).one().n>=20)throw new Fault('配对请求过多',429)
   if(this.ctx.storage.sql.exec('SELECT 1 FROM pairing WHERE id=?',pair).toArray().length)throw new Fault('配对编号已存在',409)
   this.nonce(device,proof);this.ctx.storage.sql.exec('INSERT INTO pairing(id,secret_hash,device,jwk,label,kind,expires) VALUES (?,?,?,?,?,?,?)',pair,hash(secret),device,canonical(key),String(b.label??'新设备').slice(0,80),b.kind==='archive'?'archive':'pwa',Date.now()+600000)
   return Response.json({pair_id:pair,fingerprint:hash(canonical(key)).slice(0,16),expires:Date.now()+600000})
  }
  if(action==='pair/claim'){
   const pair=this.ctx.storage.sql.exec<any>('SELECT * FROM pairing WHERE id=?',hex.parse(b.pair_id)).toArray()[0]
   if(!pair||pair.expires<Date.now()||pair.device!==device||pair.secret_hash!==hash(hex.parse(b.secret))||pair.claimed||!pair.approved)throw new Fault('配对未批准、已过期或已使用',403,'auth')
   const proof=await verify(r,raw,JSON.parse(pair.jwk),space,device,action);this.ctx.storage.transactionSync(()=>{this.nonce(device,proof);this.ctx.storage.sql.exec('INSERT INTO devices(id,jwk,label,role,kind) VALUES (?,?,?,?,?)',device,pair.jwk,pair.label,pair.role,pair.kind);this.ctx.storage.sql.exec('UPDATE pairing SET claimed=1 WHERE id=?',pair.id)})
   return Response.json(this.status())
  }
  if(action==='recover'){
   const key=jwk.parse(b.public_key),proof=await verify(r,raw,key,space,device,action)
   if(hash(hex.parse(b.recovery))!==this.get('recovery_hash'))throw new Fault('恢复凭证无效',403,'auth')
   this.nonce(device,proof);this.ctx.storage.sql.exec('INSERT INTO devices(id,jwk,label,role,kind) VALUES (?,?,?,?,?)',device,canonical(key),String(b.label??'恢复设备').slice(0,80),'owner','pwa');return Response.json(this.status())
  }
  if(!owner||owner.revoked)throw new Fault('设备未绑定或已撤销',401,'auth')
  this.nonce(device,await verify(r,raw,JSON.parse(owner.jwk),space,device,action))
  if(action==='status')return Response.json(this.status())
  if((['pair/approve','recovery/rotate','activate','archive/register','archive/rebind'].includes(action)||action==='device/revoke'&&b.device_id!==device)&&owner.role!=='owner')throw new Fault('需要空间管理权限',403,'permission')
  if(action==='pair/approve'){
   const pair=this.ctx.storage.sql.exec<any>('SELECT * FROM pairing WHERE id=?',hex.parse(b.pair_id)).toArray()[0];if(!pair||pair.expires<Date.now()||pair.secret_hash!==hash(hex.parse(b.secret))||pair.claimed)throw new Fault('配对请求无效',403)
   if(b.fingerprint!==hash(pair.jwk).slice(0,16))throw new Fault('设备指纹不一致',409,'integrity')
   this.ctx.storage.sql.exec('UPDATE pairing SET approved=1,role=? WHERE id=?',b.role==='owner'?'owner':'member',pair.id);return Response.json({approved:true,label:pair.label})
  }
  if(action==='device/revoke'){const target=id.parse(b.device_id);if(target===device&&owner.role==='owner'&&this.ctx.storage.sql.exec<{n:number}>("SELECT count(*) AS n FROM devices WHERE role='owner' AND revoked=0").one().n<2)throw new Fault('请先保留另一管理设备或恢复身份，再撤销最后的管理设备',409,'permission');this.ctx.storage.sql.exec('UPDATE devices SET revoked=1 WHERE id=?',target);return Response.json({revoked:true})}
  if(action==='recovery/rotate'){this.put('recovery_hash',hex.parse(b.recovery_hash));return Response.json({rotated:true})}
  if(action==='batch/put'){
   const file=id.parse(b.file_id),batchId=id.parse(b.batch_id),digest=hex.parse(b.digest),bytes=decode(z.string().max(1400000).parse(b.data))
   if(bytes.length>1048576||hash(bytes)!==digest)throw new Fault('批次SHA-256无效',409,'integrity')
   const existing=this.ctx.storage.sql.exec<any>('SELECT * FROM batches WHERE file_id=? OR batch_id=?',file,batchId).toArray()[0]
   if(existing){if(existing.file_id!==file||existing.batch_id!==batchId||existing.digest!==digest)throw new Fault('不可变批次编号内容冲突，停止合并',409,'integrity');return Response.json({seq:existing.seq,digest:existing.digest})}
   if(this.ctx.storage.sql.exec('SELECT 1 FROM media WHERE id=?',file).toArray().length)throw new Fault('文件编号冲突',409,'integrity')
   const batch=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(batch.protocol!==1||batch.id!==batchId||!id.safeParse(batch.writerDeviceId).success||!Array.isArray(batch.operations)||!batch.operations.length||batch.operations.length>500)throw new Fault('操作批次协议无效',400,'integrity')
   const ops:any[]=[],seenIds=new Map<string,string>(),seenSequences=new Map<string,string>();for(const op of batch.operations){validateOperation(op);const digest=hash(canonical({...op,uploaded:0}));const sequenceKey=op.deviceId+':'+op.sequence;if(seenIds.has(op.id)&&seenIds.get(op.id)!==digest||seenSequences.has(sequenceKey)&&seenSequences.get(sequenceKey)!==op.id)throw new Fault('同批操作编号或序号内容冲突',409,'integrity');seenIds.set(op.id,digest);seenSequences.set(sequenceKey,op.id);const old=this.ctx.storage.sql.exec<any>('SELECT * FROM operations WHERE id=? OR (device=? AND sequence=?)',op.id,op.deviceId,op.sequence).toArray()[0];if(old&&(old.id!==op.id||old.digest!==digest))throw new Fault('操作编号或设备序号冲突',409,'integrity');if(op.patch.attachments!==undefined&&!Array.isArray(op.patch.attachments))throw new Fault('附件索引无效',400,'integrity');for(const a of (op.patch.attachments??[]) as any[]){filename.parse(a.file);if(!this.ctx.storage.sql.exec('SELECT 1 FROM media WHERE file=? AND ready=1',a.file).toArray().length)throw new Fault('操作引用的媒体尚未完整上传',409,'media')}ops.push({op,digest})}
   if(this.used()+bytes.length>LIMIT)throw new Fault('免费空间保护上限已到；保留本地数据，未删除任何历史',507,'quota')
   let seq=0;this.ctx.storage.transactionSync(()=>{for(const {op,digest} of ops)this.ctx.storage.sql.exec('INSERT OR IGNORE INTO operations VALUES (?,?,?,?)',op.id,op.deviceId,op.sequence,digest);this.ctx.storage.sql.exec("INSERT INTO changes(kind,id) VALUES ('batch',?)",file);seq=this.head();this.ctx.storage.sql.exec('INSERT INTO batches VALUES (?,?,?,?,?)',file,batchId,digest,bytes.buffer,seq)})
   return Response.json({seq,digest})
  }
  if(action==='batch/get'){const row=this.ctx.storage.sql.exec<any>('SELECT file_id,batch_id,digest,body,seq FROM batches WHERE file_id=?',id.parse(b.file_id)).toArray()[0];return Response.json(row?{file_id:row.file_id,batch_id:row.batch_id,digest:row.digest,seq:row.seq,data:b64(new Uint8Array(row.body))}:null)}
  if(action==='changes'){
   const after=z.number().int().min(0).parse(b.after??0),until=z.number().int().min(after).max(this.head()).parse(b.until??this.head()),limit=z.number().int().min(1).max(100).parse(b.limit??50),kind=b.kind==='batch'?'batch':b.kind==='media'?'media':null
   const query='SELECT seq,kind,id FROM changes WHERE seq>? AND seq<=?'+(kind?' AND kind=?':'')+' ORDER BY seq LIMIT ?',rows=this.ctx.storage.sql.exec<any>(query,...(kind?[after,until,kind,limit+1]:[after,until,limit+1])).toArray(),more=rows.length>limit,selected=rows.slice(0,limit)
   const items=selected.map(c=>c.kind==='batch'?{...c,...this.ctx.storage.sql.exec<any>('SELECT batch_id,digest FROM batches WHERE file_id=?',c.id).one()}:{...c,...this.ctx.storage.sql.exec<any>('SELECT file,sha,size,mime FROM media WHERE id=?',c.id).one()})
   return Response.json({items,until,next_after:more?selected.at(-1).seq:null,cursor:until})
  }
  if(action==='media/status'||action==='media/begin'){
   const file=filename.parse(b.file);let row=this.ctx.storage.sql.exec<any>('SELECT * FROM media WHERE file=?',file).toArray()[0]
   if(action==='media/begin'){const fileId=id.parse(b.file_id),sha=hex.parse(b.sha256),size=z.number().int().min(1).max(32*1024*1024).parse(b.size),mime=z.string().min(1).max(100).parse(b.mime);if(row&&(row.id!==fileId||row.sha!==sha||row.size!==size||row.mime!==mime))throw new Fault('媒体编号或内容冲突',409,'integrity');if(!row){if(this.ctx.storage.sql.exec('SELECT 1 FROM batches WHERE file_id=?',fileId).toArray().length)throw new Fault('文件编号冲突',409,'integrity');this.ctx.storage.sql.exec('INSERT INTO media(file,id,sha,size,mime) VALUES (?,?,?,?,?)',file,fileId,sha,size,mime);row=this.ctx.storage.sql.exec<any>('SELECT * FROM media WHERE file=?',file).one()}}
   if(!row)return Response.json(null);const parts=new Set(this.ctx.storage.sql.exec<{part:number}>('SELECT part FROM chunks WHERE file=?',file).toArray().map(r=>r.part));return Response.json({...row,chunk_size:CHUNK,missing:Array.from({length:Math.ceil(row.size/CHUNK)},(_,n)=>n).filter(n=>!parts.has(n))})
  }
  if(action==='media/put'){
   const file=filename.parse(b.file),row=this.ctx.storage.sql.exec<any>('SELECT * FROM media WHERE file=?',file).toArray()[0];if(!row)throw new Fault('媒体未初始化');if(row.ready)return Response.json({ready:true})
   const part=z.number().int().min(0).max(Math.ceil(row.size/CHUNK)-1).parse(b.part),bytes=decode(z.string().max(131072).parse(b.data));if(bytes.length!==Math.min(CHUNK,row.size-part*CHUNK))throw new Fault('媒体分片长度无效',409,'integrity')
   const old=this.ctx.storage.sql.exec<any>('SELECT body FROM chunks WHERE file=? AND part=?',file,part).toArray()[0];if(old&&hash(new Uint8Array(old.body))!==hash(bytes))throw new Fault('媒体分片内容冲突',409,'integrity');if(!old){if(this.used()+bytes.length>LIMIT)throw new Fault('空间容量保护上限，媒体保留本机',507,'quota');this.ctx.storage.sql.exec('INSERT INTO chunks VALUES (?,?,?)',file,part,bytes.buffer)}return Response.json({saved:true})
  }
  if(action==='media/commit'){
   const file=filename.parse(b.file),row=this.ctx.storage.sql.exec<any>('SELECT * FROM media WHERE file=?',file).toArray()[0];if(!row)throw new Fault('媒体不存在');if(row.ready)return Response.json({ready:true,seq:row.seq})
   const chunks=this.ctx.storage.sql.exec<any>('SELECT part,body FROM chunks WHERE file=? ORDER BY part',file).toArray();if(chunks.length!==Math.ceil(row.size/CHUNK)||chunks.some((c,n)=>c.part!==n))throw new Fault('媒体尚未完整上传',409,'media');const sha=createHash('sha256');for(const c of chunks)sha.update(new Uint8Array(c.body));if(sha.digest('hex')!==row.sha)throw new Fault('媒体SHA-256不一致',409,'integrity')
   let seq=0;this.ctx.storage.transactionSync(()=>{this.ctx.storage.sql.exec("INSERT INTO changes(kind,id) VALUES ('media',?)",row.id);seq=this.head();this.ctx.storage.sql.exec('UPDATE media SET ready=1,seq=? WHERE file=?',seq,file)});return Response.json({ready:true,seq})
  }
  if(action==='media/get'){const file=filename.parse(b.file),part=z.number().int().min(0).parse(b.part),row=this.ctx.storage.sql.exec<any>('SELECT * FROM media WHERE file=? AND ready=1',file).toArray()[0];if(!row)throw new Fault('媒体尚未就绪',404,'media');const chunk=this.ctx.storage.sql.exec<any>('SELECT body FROM chunks WHERE file=? AND part=?',file,part).toArray()[0];return Response.json(chunk?{data:b64(new Uint8Array(chunk.body)),sha256:row.sha,size:row.size,mime:row.mime}:null)}
  if(action==='cursor/ack'){const cursor=z.number().int().min(0).max(this.head()).parse(b.cursor);this.ctx.storage.sql.exec('UPDATE devices SET cursor=max(cursor,?) WHERE id=?',cursor,device);return Response.json({cursor})}
  if(action==='manifest')return Response.json({...this.manifest(),head:this.head()})
  if(action==='archive/register'){
   if(owner.kind!=='archive')throw new Fault('此设备不是归档服务',403,'permission');const binding={archive_id:hex.parse(b.archive_id),storage_id:hex.parse(b.storage_id),primary_os:z.enum(['windows','linux']).parse(b.primary_os),device_id:device,cursor:0,last_success:null,manifest:null},old=this.get('archive')
   if(old&&(old.archive_id!==binding.archive_id||old.storage_id!==binding.storage_id||old.primary_os!==binding.primary_os||old.device_id!==device))throw new Fault('已有唯一归档中心，不能自动创建第二份权威档案',409,'archive')
   if(!old)this.put('archive',binding);return Response.json(old??binding)
  }
  if(action==='archive/rebind'){
   const archive=this.get('archive'),next=this.ctx.storage.sql.exec<any>('SELECT * FROM devices WHERE id=? AND revoked=0',id.parse(b.device_id)).toArray()[0]
   if(!archive||archive.archive_id!==b.archive_id||!next||next.kind!=='archive'||next.role!=='owner'||b.confirm_restore!==true)throw new Fault('更换归档中心需要明确恢复确认及已批准的归档设备',409,'archive')
   this.put('archive',{archive_id:archive.archive_id,storage_id:hex.parse(b.storage_id),primary_os:z.enum(['windows','linux']).parse(b.primary_os),device_id:next.id,cursor:0,last_success:null,manifest:null});return Response.json(this.get('archive'))
  }
  if(action==='archive/ack'){
   const archive=this.get('archive');if(!archive||archive.device_id!==device||owner.kind!=='archive'||archive.storage_id!==b.storage_id||archive.archive_id!==b.archive_id)throw new Fault('归档身份或实际存储目录不一致',403,'archive')
   const cursor=z.number().int().min(archive.cursor).max(this.head()).parse(b.cursor),manifest=b.manifest;const entries=this.ctx.storage.sql.exec<any>('SELECT seq,kind,id FROM changes WHERE seq<=? ORDER BY seq',cursor).toArray();const proof=hash(canonical(entries.map(e=>({seq:e.seq,kind:e.kind,id:e.id,digest:e.kind==='batch'?this.ctx.storage.sql.exec<any>('SELECT digest FROM batches WHERE file_id=?',e.id).one().digest:this.ctx.storage.sql.exec<any>('SELECT sha FROM media WHERE id=?',e.id).one().sha}))))
   if(proof!==manifest)throw new Fault('归档持久化清单与云端不一致',409,'integrity');this.put('archive',{...archive,cursor,last_success:new Date().toISOString(),manifest});return Response.json(this.get('archive'))
  }
  if(action==='migration/prepare'){
   if(owner.kind!=='pwa')throw new Fault('迁移准备需要已绑定PWA确认',403,'permission')
   if(b.source_confirmed!==true||!hex.safeParse(b.backup_digest).success)throw new Fault('请先下载迁移前备份，并确认已完成最后一次旧渠道同步',409,'migration')
   this.ctx.storage.sql.exec('INSERT OR REPLACE INTO migration_preparations VALUES (?,?,?)',device,b.backup_digest,Date.now())
   return Response.json({prepared:true,verified:false,mode:this.get('mode','staging')})
  }
  if(action==='migration/verify'){
   if(owner.kind!=='pwa')throw new Fault('迁移设备核验需要PWA',403);const manifest=this.manifest();if(canonical(b.manifest)!==canonical(manifest)||b.head!==this.head()||b.source_confirmed!==true||!hex.safeParse(b.backup_digest).success)throw new Fault('数据、媒体或迁移前备份尚未核验一致',409,'migration')
   this.ctx.storage.sql.exec('INSERT OR REPLACE INTO migration VALUES (?,?,?,?,?,?)',device,b.head,canonical(manifest),b.backup_digest,1,Date.now());return Response.json({verified:true,head:b.head})
  }
  if(action==='activate'){
   const archive=this.get('archive'),head=this.head(),checks=this.ctx.storage.sql.exec<any>("SELECT m.* FROM migration m JOIN devices d ON m.device=d.id WHERE d.revoked=0 AND d.kind='pwa' AND m.head=? AND m.confirmed=1 AND m.time>?",head,Date.now()-86400000).toArray()
   if(!archive||archive.cursor!==head||!archive.manifest||checks.length<2)throw new Fault('正式切换需电脑持久归档及至少两台PWA在当前云端序号核验一致',409,'migration')
   this.put('mode','active');return Response.json(this.status())
  }
  throw new Fault('接口不存在',404)
 }catch(e){return Response.json({error:e instanceof Fault?e.message:e instanceof z.ZodError?'参数格式无效':e instanceof Error?e.message:'同步请求失败',code:e instanceof Fault?e.code:'invalid'},{status:e instanceof Fault?e.status:400})}})}
}
export default {async fetch(request:Request,env:Env){try{
 const path=new URL(request.url).pathname;if(path==='/')return Response.json({service:'LifeOS Sync Hub',protocol:'lifeos-sync-v1',auth:'P-256 device signatures',retention:'phase1-full-history-no-pruning'})
 if(!path.startsWith('/v1/')||request.method!=='POST')return new Response('Not found',{status:404})
 const action=path.slice(4),ip=request.headers.get('CF-Connecting-IP')??'local',limit=env.LIMITER.get(env.LIMITER.idFromName(hash(ip))),max=['create','recover','pair/request','pair/claim'].includes(action)?30:1200
 const allowed=await limit.fetch(new Request('https://limit',{method:'POST',body:JSON.stringify({key:action==='create'?'create':action==='recover'?'recover':['pair/request','pair/claim'].includes(action)?'pairing':'requests',max,window:action==='create'?86400000:60000})}));if(!(await allowed.json() as any).allowed)return Response.json({error:'请求过于频繁，稍后自动重试',code:'rate'},{status:429})
 const space=hex.parse(request.headers.get('X-LifeOS-Space'))
 if(action==='create'){const copy=request.clone(),{value}=await input(copy);if(!env.SYNC_CREATE_HASH||hash(String(value.bootstrap??''))!==env.SYNC_CREATE_HASH)return Response.json({error:'首次创建需要本机安全初始化凭证',code:'permission'},{status:403})}
 return env.SPACES.get(env.SPACES.idFromName(space)).fetch(new Request('https://space/'+action,{method:'POST',headers:request.headers,body:request.body}))
 }catch{return Response.json({error:'同步请求格式无效',code:'invalid'},{status:400})}}}
