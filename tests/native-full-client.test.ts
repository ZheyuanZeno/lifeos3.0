import {beforeEach,afterEach,it,expect} from 'vitest'
import {PocketDatabase} from '../lifeos/pocket/src/database'
import {initialize,recordDraft,saveRecord} from '../lifeos/pocket/src/repository'
import {FullBusinessClient} from '../lifeos/pocket/src/native-full-client'
import {mediaDigest} from '../lifeos/pocket/src/media'
let db:PocketDatabase
beforeEach(async()=>{db=new PocketDatabase('native-publish-'+crypto.randomUUID());await initialize(db)})
afterEach(async()=>{await db.delete()})
it('resumes a bounded multi-page upload and keeps a coherent snapshot while local records change',async()=>{
 const rows=Array.from({length:501},(_,n)=>({...recordDraft('module-pocket-notes','2020-01-01','note'),id:'test'+n,title:'note '+n,body:'original'}));await db.records.bulkAdd(rows)
 let generation='',staging:any[]=[],active='',published:any[]=[]
 const client=new FullBusinessClient(db,async(action,b:any)=>{
  expect(action).toBe('business')
  if(b.phase==='begin'){if(generation!==b.generation){generation=b.generation;staging=[]}return {published:active===b.generation,received:staging.length,media_epoch:'epoch'}}
  if(b.phase==='page'){staging.push(...b.rows);return {saved:b.rows.length}}
  published=[...staging];active=generation;return {published:true}
 })
 expect(await client.publish()).toContain('上传中')
 await saveRecord({...rows[0],body:'edited during upload'},db)
 await client.publish();expect(published.find(r=>r.id===rows[0].id).data.body).toBe('original')
 expect(await client.publish()).toContain('上传中');await client.publish();expect(published.find(r=>r.id===rows[0].id).data.body).toBe('edited during upload')
})
it('uploads the actual referenced binary once and resends after the cloud media epoch changes',async()=>{
 const file='a'.repeat(32)+'.wav',bytes=new Uint8Array(200000),sha=await mediaDigest(bytes)
 await db.records.add({...recordDraft('module-pocket-notes','2020-01-01','note'),title:'audio',attachments:[{file,name:'recording.wav'}]});await db.media.put({file,bytes:bytes.buffer,size:bytes.length,mime:'audio/wav',sha256:sha,createdAt:'2020-01-01T00:00:00Z'})
 let active='',epoch='one',ready=false;const chunks=new Map<number,Uint8Array>();let sent=0
 const client=new FullBusinessClient(db,async(action,b:any)=>{
  if(action==='business'){if(b.phase==='begin')return {published:active===b.generation,media_epoch:epoch};if(b.phase==='commit')active=b.generation;return {published:true}}
  if(b.phase==='status')return {ready,missing:[0,1,2].filter(n=>!chunks.has(n)),chunk_size:98304}
  if(b.phase==='chunk'){sent++;chunks.set(b.index,Uint8Array.from(atob(b.data),c=>c.charCodeAt(0)));return {saved:true}}
  const joined=new Uint8Array(200000);for(const [n,p] of chunks)joined.set(p,n*98304);expect(await mediaDigest(joined)).toBe(sha);ready=true;return {ready:true}
 })
 await client.publish();expect(sent).toBe(3);await client.publish();expect(sent).toBe(3)
 epoch='two';ready=false;chunks.clear();await client.publish();expect(sent).toBe(6)
})
