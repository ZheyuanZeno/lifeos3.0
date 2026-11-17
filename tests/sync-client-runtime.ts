import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import {PocketDatabase} from '../lifeos/pocket/src/database'
import {initialize,recordDraft,saveRecord,startSession,endSession,restoreBackup,exportBackup} from '../lifeos/pocket/src/repository'
import {CloudflareSyncTransport} from '../lifeos/pocket/src/sync/cloudflare'
import {newSyncIdentity,randomId} from '../lifeos/pocket/src/sync/identity'
import {sync,pendingCount} from '../lifeos/pocket/src/sync/engine'
import {digest} from '../lifeos/pocket/src/sync/protocol'
export async function exercise(endpoint:string,bootstrap:string,fetcher:typeof fetch){
 const space=randomId(),first=await newSyncIdentity(space,'PWA fixture A'),second=await newSyncIdentity(space,'PWA fixture B'),a=new PocketDatabase('cf-fixture-'+randomId(8)),b=new PocketDatabase('cf-fixture-'+randomId(8)),ta=new CloudflareSyncTransport(first,endpoint+'/v1',fetcher),tb=new CloudflareSyncTransport(second,endpoint+'/v1',fetcher)
 try{
  await ta.request('create',{bootstrap,public_key:first.publicKey,recovery_hash:await digest(new TextEncoder().encode(randomId())),kind:'pwa'})
  const pair_id=randomId(),secret=randomId(),requested=await tb.request('pair/request',{pair_id,secret,public_key:second.publicKey,kind:'pwa'})
  await ta.request('pair/approve',{pair_id,secret,fingerprint:requested.fingerprint});await tb.request('pair/claim',{pair_id,secret})
  await initialize(a);await initialize(b)
  const row=await saveRecord({...recordDraft('module-pocket-notes','2026-11-01','note'),title:'Long offline fixture',body:'Preserved content'},a)
  const bytes=new Uint8Array([82,73,70,70,1,2,3]),file='a'.repeat(32)+'.wav'
  await a.media.put({file,bytes:bytes.buffer,mime:'audio/wav',sha256:await digest(bytes),size:bytes.length,createdAt:'2026-11-01T10:00:00Z'})
  await saveRecord({...row,attachments:[{file,name:'Deleted history recording'}]},a)
  await saveRecord({...row,deleted:true},a)
  const s1=await startSession('routine','daily-cooking',100000,a),s2=await startSession('routine','daily-eating',110000,a)
  assert.notEqual(s1.id,s2.id);assert.equal(await a.sessions.filter(s=>s.endedAt===null&&!s.deleted).count(),2)
  await sync(a,ta);await sync(b,tb);await sync(a,ta)
  assert.equal((await b.records.get(row.id))?.deleted,true)
  assert.equal((await b.media.get(file))?.sha256,await digest(bytes))
  assert.equal(await b.sessions.filter(s=>s.endedAt===null&&!s.deleted).count(),2)
  await endSession(s1.id,200000,b);await sync(b,tb);await sync(a,ta)
  assert.equal((await a.sessions.get(s1.id))?.endedAt,new Date(200000).toISOString())
  assert.equal((await a.sessions.get(s2.id))?.endedAt,null)
  const count=(await ta.status()).head;await sync(a,ta);assert.equal((await ta.status()).head,count)
  assert.deepEqual(await ta.localManifest(a),(await ta.status()).manifest)
  assert.equal(await pendingCount(a,ta.accountId),0);assert.ok(await pendingCount(a,'unrelated-drive-account')>0)
  const restored=new PocketDatabase('cf-restored-'+randomId(8));try{await restoreBackup(await exportBackup(a),restored);assert.equal(await restored.operations.count(),await a.operations.count());assert.equal((await restored.media.get(file))?.sha256,await digest(bytes))}finally{await restored.delete()}
  const left='c'.repeat(32)+'.wav',right='d'.repeat(32)+'.wav',leftBytes=new Uint8Array([1,2,3,4]),rightBytes=new Uint8Array([5,6,7,8])
  const split=await saveRecord({...recordDraft('module-pocket-notes','2026-11-01','note'),title:'Split historical originals',attachments:[{file:left,name:'Left original'},{file:right,name:'Right original'}]},a)
  await saveRecord({...split,deleted:true,attachments:[]},a)
  await restoreBackup({...await exportBackup(a),media:[]},b)
  await a.media.put({file:left,bytes:leftBytes.buffer,mime:'audio/wav',size:leftBytes.length,sha256:await digest(leftBytes),createdAt:'2026-11-01T10:00:00Z'})
  await b.media.put({file:right,bytes:rightBytes.buffer,mime:'audio/wav',size:rightBytes.length,sha256:await digest(rightBytes),createdAt:'2026-11-01T10:00:00Z'})
  await assert.rejects(sync(a,ta),error=>String(error).includes(right))
  assert.equal((await ta.request('media/status',{file:left})).ready,1,'Local originals must upload before waiting for another device')
  await sync(b,tb);await sync(a,ta)
  for(const database of [a,b]){assert.equal((await database.media.get(left))?.sha256,await digest(leftBytes));assert.equal((await database.media.get(right))?.sha256,await digest(rightBytes));assert.equal((await database.records.get(split.id))?.deleted,true)}
  const missing='e'.repeat(32)+'.wav',lost=await saveRecord({...recordDraft('module-pocket-notes','2026-11-01','note'),title:'Missing historical original',attachments:[{file:missing,name:'Missing original'}]},a)
  await saveRecord({...lost,deleted:true,attachments:[]},a)
  const opCount=await a.operations.count();await assert.rejects(sync(a,ta),error=>String(error).includes(missing));assert.equal(await a.operations.count(),opCount);assert.equal((await a.records.get(lost.id))?.deleted,true);assert.equal((await ta.status()).mode,'staging');assert.ok(await pendingCount(a,ta.accountId)>0)
  console.log('PASS: reciprocal tombstoned recordings contribute before waiting; permanently missing originals block migration without deleting history')
  console.log('PASS: two actual Dexie clients + real workerd, independent ACK namespaces, parallel timers, tombstone/orphan media retention, idempotency and old backup format')
 }finally{await a.delete();await b.delete()}
}
