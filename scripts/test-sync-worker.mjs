import {Miniflare} from 'miniflare'
import {build} from 'esbuild'
import {createHash,randomBytes,webcrypto} from 'node:crypto'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {writeFile,unlink} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
import path from 'node:path'
const sha=v=>createHash('sha256').update(v).digest('hex')
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}'
const secret=randomBytes(32).toString('hex'),space=randomBytes(32).toString('hex'),recovery=randomBytes(32).toString('hex')
const bundle=await build({entryPoints:['workers/sync/src/index.ts'],bundle:true,write:false,format:'esm',platform:'node',target:'es2023',external:['node:*','cloudflare:*']})
const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-01',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],durableObjects:{SPACES:{className:'SyncSpace',useSQLite:true},LIMITER:{className:'SyncLimiter',useSQLite:true}},bindings:{SYNC_CREATE_HASH:sha(secret)}})
async function identity(kind='pwa'){const keys=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);return {id:randomBytes(16).toString('hex'),keys,key:await webcrypto.subtle.exportKey('jwk',keys.publicKey),kind}}
async function signed(device,action,value={},options={}){const body=JSON.stringify(value),time=String(Date.now()),nonce=randomBytes(16).toString('hex'),envelope=JSON.stringify(['lifeos-sync-auth-v1',options.space??space,device.id,action,time,nonce,sha(body)]),sig=await webcrypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},device.keys.privateKey,Buffer.from(envelope));return {method:'POST',headers:{'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.10','X-LifeOS-Space':options.space??space,'X-LifeOS-Device':device.id,'X-LifeOS-Time':time,'X-LifeOS-Nonce':nonce,'X-LifeOS-Signature':Buffer.from(sig).toString('base64')},body}}
async function send(action,request){const r=await mf.dispatchFetch('https://sync.test/v1/'+action,request);return {status:r.status,data:await r.json()}}
async function call(d,a,v={},expected=200){const r=await send(a,await signed(d,a,v));assert.equal(r.status,expected,a+': '+JSON.stringify(r.data));return r.data}
async function pair(owner,device,role='member'){const pair_id=randomBytes(32).toString('hex'),pairSecret=randomBytes(32).toString('hex');const requested=await call(device,'pair/request',{pair_id,secret:pairSecret,public_key:device.key,label:'Test device',kind:device.kind});await call(device,'pair/claim',{pair_id,secret:pairSecret},403);await call(owner,'pair/approve',{pair_id,secret:pairSecret,fingerprint:requested.fingerprint,role});await call(device,'pair/claim',{pair_id,secret:pairSecret});await call(device,'pair/claim',{pair_id,secret:pairSecret},403)}
try{
 const owner=await identity('archive'),phone=await identity(),second=await identity()
 await call(owner,'create',{bootstrap:'wrong',public_key:owner.key,recovery_hash:sha(recovery)},403)
 await call(owner,'create',{bootstrap:secret,public_key:owner.key,recovery_hash:sha(recovery),kind:'archive'})
 await call(owner,'device/revoke',{device_id:owner.id},409)
 const replay=await signed(owner,'status');assert.equal((await send('status',replay)).status,200);assert.equal((await send('status',replay)).status,409)
 const tampered=await signed(owner,'status');tampered.body='{"altered":true}';assert.equal((await send('status',tampered)).status,401)
 assert.equal((await send('status',await signed(owner,'status',{}, {space:'f'.repeat(64)}))).status,404)
 await pair(owner,phone);await pair(owner,second)
 await call(phone,'device/revoke',{device_id:second.id},403)
 const archive_id=randomBytes(32).toString('hex'),storage_id=randomBytes(32).toString('hex')
 await call(owner,'archive/register',{archive_id,storage_id,primary_os:'windows'})
 await call(owner,'archive/register',{archive_id,storage_id:'a'.repeat(64),primary_os:'linux'},409)
 const file='b'.repeat(32)+'.webm',bytes=randomBytes(220000),mediaId='media_test',digest=sha(bytes)
 await call(phone,'media/begin',{file,file_id:mediaId,sha256:digest,size:bytes.length,mime:'audio/webm'})
 await call(phone,'media/put',{file,part:0,data:bytes.subarray(0,98304).toString('base64')})
 await call(phone,'media/commit',{file},409)
 assert.deepEqual((await call(phone,'media/status',{file})).missing,[1,2])
 for(let part=1;part<3;part++)await call(phone,'media/put',{file,part,data:bytes.subarray(part*98304,(part+1)*98304).toString('base64')})
 await call(phone,'media/commit',{file});await call(phone,'media/commit',{file})
 const read=[];for(let part=0;part<3;part++)read.push(Buffer.from((await call(second,'media/get',{file,part})).data,'base64'));assert.equal(sha(Buffer.concat(read)),digest)
 const operations=Array.from({length:10},(_,n)=>({id:'op_'+n,deviceId:'test_writer',sequence:n+1,clock:n+1,context:{test_writer:n},entity:'records',recordId:'record_'+n,patch:{title:'Test '+n,...(n===0?{attachments:[{file,name:'Test recording'}]}:{})},timestamp:'2026-11-17T10:00:00.000Z',uploaded:0}))
 const batch={protocol:1,id:'batch_1',writerDeviceId:'test_writer',createdAt:'2026-11-17T10:00:00.000Z',operations},body=Buffer.from(canonical(batch)),put={file_id:'file_1',batch_id:batch.id,digest:sha(body),data:body.toString('base64')}
 const result=await call(phone,'batch/put',put);assert.equal(result.seq,2);assert.equal((await call(second,'batch/put',put)).seq,2)
 assert.equal((await call(owner,'manifest')).operation_count,10)
 await call(phone,'batch/put',{...put,digest:'a'.repeat(64)},409)
 const changed={...batch,id:'batch_2',operations:[{...operations[0],patch:{title:'Collision'}}]},changedBytes=Buffer.from(canonical(changed));await call(phone,'batch/put',{file_id:'file_2',batch_id:changed.id,digest:sha(changedBytes),data:changedBytes.toString('base64')},409)
 const page1=await call(phone,'changes',{after:0,until:2,limit:1});assert.equal(page1.items.length,1);assert.equal(page1.next_after,1)
 const page2=await call(phone,'changes',{after:page1.next_after,until:2,limit:1});assert.equal(page2.items[0].id,'file_1');assert.equal(page2.next_after,null)
 assert.equal(sha(Buffer.from((await call(phone,'batch/get',{file_id:'file_1'})).data,'base64')),put.digest)
 await call(owner,'activate',{},409)
 const manifest=await call(phone,'manifest'),verify={manifest:{operation_count:manifest.operation_count,operation_ids_digest:manifest.operation_ids_digest,media_count:manifest.media_count,media_digest:manifest.media_digest},head:2,source_confirmed:true,backup_digest:'a'.repeat(64)}
 await call(phone,'migration/verify',verify);await call(second,'migration/verify',verify)
 await call(owner,'archive/ack',{archive_id,storage_id,cursor:2,manifest:'a'.repeat(64)},409)
 const proof=sha(canonical([{seq:1,kind:'media',id:mediaId,digest},{seq:2,kind:'batch',id:'file_1',digest:put.digest}]))
 await call(owner,'archive/ack',{archive_id,storage_id,cursor:2,manifest:proof})
 assert.equal((await call(owner,'activate')).mode,'active')
 await call(owner,'device/revoke',{device_id:second.id});await call(second,'status',{},401)
 const restored=await identity();await call(restored,'recover',{public_key:restored.key,recovery:'0'.repeat(64)},403);await call(restored,'recover',{public_key:restored.key,recovery});assert.equal((await call(restored,'status')).devices.find(d=>d.id===restored.id).role,'owner')
 await call(restored,'device/revoke',{device_id:restored.id});await call(restored,'status',{},401)
 const runtime=await build({entryPoints:['tests/sync-client-runtime.ts'],bundle:true,write:false,format:'esm',platform:'node',target:'es2023',external:['node:*']})
 const runtimeFile=path.join(process.env.LIFEOS_TEST_TMP??'E:/Codex/tmp','lifeos-sync-client-'+randomBytes(8).toString('hex')+'.mjs')
 await writeFile(runtimeFile,runtime.outputFiles[0].text)
 try{const client=await import(pathToFileURL(runtimeFile));await client.exercise('https://sync.test',secret,(url,options)=>mf.dispatchFetch(url,options))}finally{await unlink(runtimeFile)}
 if(process.env.LIFEOS_ARCHIVE_PYTHON){
  const endpoint=(await mf.ready).origin
  await new Promise((resolve,reject)=>{const child=spawn(process.env.LIFEOS_ARCHIVE_PYTHON,['tests/archive_live_fixture.py',endpoint,secret],{stdio:['ignore','pipe','pipe'],env:process.env});let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);child.on('error',reject);child.on('close',code=>code===0?(console.log(output.trim()),resolve()):reject(Error(output)))})
 }
 console.log('PASS: real workerd signed auth, replay/namespace isolation, pairing/revocation/recovery, immutable batches, media resume+SHA, pagination, archive proof and two-device migration gate')
}finally{await mf.dispose()}
