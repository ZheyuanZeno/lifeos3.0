import Dexie from 'dexie'
import { afterEach,describe,expect,it } from 'vitest'
import { PocketDatabase } from '../lifeos/pocket/src/database'
import { initialize,recordDraft,saveRecord,saveRoutine,startSession,endSession,exportBackup,restoreBackup } from '../lifeos/pocket/src/repository'
import { sync,pendingCount } from '../lifeos/pocket/src/sync/engine'
import { MemoryDrive } from './sync-memory'
import { SyncError } from '../lifeos/pocket/src/sync/types'
import { isHistorySession,totalMilliseconds } from '../lifeos/pocket/src/time'
const databases:PocketDatabase[]=[]
function database(){const db=new PocketDatabase('sync-'+crypto.randomUUID());databases.push(db);return db}
afterEach(async()=>{for(const db of databases.splice(0))await db.delete()})
it('removes an already-synced running interval when it ends within 30 seconds on its owner device',async()=>{
 const a=database(),b=database(),remote=new MemoryDrive();await initialize(a);await initialize(b)
 const s=await startSession('routine','daily-cooking',100000,a);await sync(a,remote.transport());await sync(b,remote.transport());expect((await b.sessions.get(s.id))?.endedAt).toBeNull();expect(isHistorySession((await b.sessions.get(s.id))!)).toBe(false)
 await endSession(s.id,130000,a);await sync(a,remote.transport());await sync(b,remote.transport());expect((await b.sessions.get(s.id))?.deleted).toBe(true);expect(totalMilliseconds(await b.sessions.toArray(),'daily-cooking','1970-01-01')).toBe(0)
})
it('rescans immutable history after an expired change cursor without discarding pending local work',async()=>{
 const a=database(),b=database(),remote=new MemoryDrive();await initialize(a);await initialize(b);await sync(a,remote.transport());await sync(b,remote.transport())
 const first=await note(a,'长离线后接收');await sync(a,remote.transport());const second=await note(b,'长离线期间本地')
 const transport=remote.transport();transport.listChanges=async()=>{throw new SyncError('expired','cursor')}
 await sync(b,transport);expect((await b.records.get(first.id))?.title).toBe(first.title);await sync(a,remote.transport());expect((await a.records.get(second.id))?.title).toBe(second.title);expect(await pendingCount(b,'account')).toBe(0)
})
async function note(db:PocketDatabase,title:string){return saveRecord({...recordDraft('module-pocket-notes','2026-11-14','note'),title,body:title+' 的正文'},db)}
describe('independent incremental transport',()=>{
 it('never reports a different transport as synced when channels overlap on one database',async()=>{
  const db=database(),remote=new MemoryDrive();await initialize(db);await note(db,'渠道隔离')
  const first=sync(db,remote.transport('first-channel'))
  await expect(sync(db,remote.transport('second-channel'))).rejects.toThrow('另一个同步渠道')
  await first;expect(await pendingCount(db,'first-channel')).toBe(0);expect(await pendingCount(db,'second-channel')).toBeGreaterThan(0)
 })
 it('exchanges offline notes and time sessions between two devices without duplicates',async()=>{
  const a=database(),b=database(),remote=new MemoryDrive();await initialize(a);await initialize(b);const first=await note(a,'手机离线')
  const routine=await saveRoutine({title:'学习',icon:'',category:'课题',days:[0,1,2,3,4,5,6],minimumMinutes:null,targetMinutes:30,order:0,archived:false},a),session=await startSession('routine',routine.id,100000,a);await endSession(session.id,300000,a)
  await sync(a,remote.transport());await sync(b,remote.transport());expect((await b.records.get(first.id))?.body).toBe(first.body);expect(await b.sessions.count()).toBe(1);expect(await pendingCount(b,'account')).toBe(0)
  const second=await note(b,'电脑离线');await sync(b,remote.transport());await sync(a,remote.transport());expect((await a.records.get(second.id))?.body).toBe(second.body)
  const fileCount=remote.files.size,operationCount=await a.operations.count();await sync(a,remote.transport());await sync(b,remote.transport());expect(remote.files.size).toBe(fileCount);expect(await a.operations.count()).toBe(operationCount);expect(await a.records.count()).toBe(2)
 })
 it('reuses the persisted remote ID after a committed upload loses its response and app restarts',async()=>{
  const db=database(),remote=new MemoryDrive();await initialize(db);await note(db,'断网记录');remote.loseResponse=true
  await expect(sync(db,remote.transport())).rejects.toThrow('lost');const pending=await db.cloudBatches.where('[accountId+status]').equals(['account','pending']).toArray();expect(pending).toHaveLength(1);expect(await pendingCount(db,'account')).toBeGreaterThan(0);expect(remote.files.size).toBe(1)
  db.close();await db.open();await sync(db,remote.transport());expect(remote.files.size).toBe(1);expect(remote.allocations).toBe(1);expect(await pendingCount(db,'account')).toBe(0)
 })
 it('never treats local SQLite acknowledgements as cloud confirmations, and queues downloaded ops for SQLite',async()=>{
  const a=database(),b=database(),remote=new MemoryDrive();await initialize(a);await initialize(b);await note(a,'原白板记录');await a.operations.toCollection().modify({uploaded:1})
  expect(await pendingCount(a,'account')).toBeGreaterThan(0);await sync(a,remote.transport());await sync(b,remote.transport());const pulled=await b.operations.where('deviceId').equals((await a.operations.toArray())[0].deviceId).toArray();expect(pulled.length).toBeGreaterThan(0);expect(pulled.every(o=>o.uploaded===0)).toBe(true)
 })
 it('keeps cursor, business data and cloud acks unchanged when integrity validation fails',async()=>{
  const a=database(),b=database(),remote=new MemoryDrive();await initialize(a);await initialize(b);await note(a,'完整正文');await sync(a,remote.transport());remote.corrupt=true
  const operations=await b.operations.count();await expect(sync(b,remote.transport())).rejects.toThrow('完整性');expect(await b.records.count()).toBe(0);expect(await b.operations.count()).toBe(operations);expect(await b.cloudAcks.count()).toBe(0);expect((await b.cloudState.get('account'))?.cursor).toBeUndefined()
 })
 it('collects every initial-history page before applying partial record edits',async()=>{
  const a=database(),b=database(),remote=new MemoryDrive();remote.pageSize=1;await initialize(a);await initialize(b)
  const row=await note(a,'第一版');await sync(a,remote.transport());await saveRecord({...row,body:'第二版'},a);await sync(a,remote.transport());await saveRecord({...row,body:'第三版'},a);await sync(a,remote.transport())
  await sync(b,remote.transport());expect((await b.records.get(row.id))?.body).toBe('第三版')
 })
 it('does not advance the cursor when a later initial-list page fails',async()=>{
  const a=database(),b=database(),remote=new MemoryDrive();remote.pageSize=1;await initialize(a);await initialize(b);await note(a,'A');await sync(a,remote.transport());await note(a,'B');await sync(a,remote.transport());remote.failPage=true
  await expect(sync(b,remote.transport())).rejects.toThrow('page');expect(await b.records.count()).toBe(0);expect((await b.cloudState.get('account'))?.cursor).toBeUndefined();remote.failPage=false;await sync(b,remote.transport());expect(await b.records.count()).toBe(2)
 })
 it('merges independent edits, preserves concurrent text, and never revives an offline-deleted record',async()=>{
  const a=database(),b=database(),remote=new MemoryDrive();await initialize(a);await initialize(b);const row=await note(a,'原文');await sync(a,remote.transport());await sync(b,remote.transport())
  await saveRecord({...row,deleted:true},a);await saveRecord({...row,body:'旧设备编辑'},b);await sync(a,remote.transport());await sync(b,remote.transport());await sync(a,remote.transport());expect((await a.records.get(row.id))?.deleted).toBe(true);expect((await b.records.get(row.id))?.deleted).toBe(true)
 })
 it('keeps account and OAuth-application acknowledgement namespaces separate',async()=>{
  const db=database(),first=new MemoryDrive(),second=new MemoryDrive();await initialize(db);await note(db,'本地记录');await sync(db,first.transport('clientA:account'));expect(await pendingCount(db,'clientA:account')).toBe(0);expect(await pendingCount(db,'clientB:account')).toBeGreaterThan(0);await sync(db,second.transport('clientB:account'));expect(second.files.size).toBeGreaterThan(0)
 })
 it('preserves pending operations if the network fails before download/upload',async()=>{
  const db=database(),remote=new MemoryDrive();await initialize(db);await note(db,'保留记录');remote.failReads=true;await expect(sync(db,remote.transport())).rejects.toThrow();expect(await db.records.count()).toBe(1);expect(await pendingCount(db,'account')).toBeGreaterThan(0);expect(remote.files.size).toBe(0)
 })
 it('deduplicates overlapping sync calls in the same process',async()=>{
  const db=database(),remote=new MemoryDrive();await initialize(db);await note(db,'一次上传');const transport=remote.transport();const a=sync(db,transport),b=sync(db,transport);expect(a).toBe(b);await a;expect(remote.files.size).toBe(1)
 })
 it('upgrades a populated v1 database without deleting records or changing the backup format',async()=>{
  const name='sync-'+crypto.randomUUID(),legacy=new Dexie(name);legacy.version(1).stores({modules:'id, kind',records:'id, date, module_id, type, [type+date]',routines:'id, order',completions:'id, date, routineId',sessions:'id, subjectId, startedAt, endedAt',operations:'id, uploaded, deviceId, &[deviceId+sequence], [entity+recordId]',local:'key'});await legacy.open();await legacy.table('local').put({key:'draft-metadata',value:'保留'});legacy.close()
  const upgraded=new PocketDatabase(name);databases.push(upgraded);await upgraded.open();expect((await upgraded.local.get('draft-metadata'))?.value).toBe('保留');await initialize(upgraded);await note(upgraded,'迁移后');expect((await exportBackup(upgraded)).schemaVersion).toBe(1);const restored=database();await restoreBackup(await exportBackup(upgraded),restored);expect(await restored.records.count()).toBe(1)
 })
})

it('does not overwrite an existing module name with fresh-install defaults, regardless of device ordering',async()=>{
 const a=database(),b=database(),remote=new MemoryDrive();await initialize(a);await initialize(b)
 const {putRow,transaction}=await import('../lifeos/pocket/src/repository')
 await transaction(a,async()=>{const m=(await a.modules.get('module-plans'))!;await putRow('modules',{...m,name:'我的专业课安排'},a)})
 await sync(a,remote.transport());await sync(b,remote.transport());await sync(a,remote.transport())
 expect((await a.modules.get('module-plans'))?.name).toBe('我的专业课安排');expect((await b.modules.get('module-plans'))?.name).toBe('我的专业课安排')
})
