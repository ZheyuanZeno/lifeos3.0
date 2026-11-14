import {afterEach,expect,it} from 'vitest'
import {PocketDatabase} from '../lifeos/pocket/src/database'
import {initialize,recordDraft,saveAudioRecord,exportBackup,restoreBackup,saveRoutine,startSession,endSession,deleteSession,applyOperations} from '../lifeos/pocket/src/repository'
import {makeAudio,mediaDigest} from '../lifeos/pocket/src/media'
import {sync} from '../lifeos/pocket/src/sync/engine'
import {MemoryDrive} from './sync-memory'
import {totalMilliseconds} from '../lifeos/pocket/src/time'
import type {LifeRecord,Operation,Routine} from '../lifeos/pocket/src/model'
import Dexie from 'dexie'
const databases:PocketDatabase[]=[]
function database(){const db=new PocketDatabase('media-'+crypto.randomUUID());databases.push(db);return db}
afterEach(async()=>{for(const db of databases.splice(0))await db.delete()})
it('upgrades a populated v2 database without losing records, cloud acknowledgements, cursor or drafts',async()=>{
 const name='media-upgrade-'+crypto.randomUUID(),old=new Dexie(name)
 old.version(2).stores({modules:'id, kind',records:'id, date, module_id, type, [type+date]',routines:'id, order',completions:'id, date, routineId',sessions:'id, subjectId, startedAt, endedAt',operations:'id, uploaded, deviceId, &[deviceId+sequence], [entity+recordId]',local:'key',cloudAcks:'key, accountId, operationId',cloudFiles:'key, accountId, fileId',cloudBatches:'key, accountId, [accountId+status]',cloudState:'key'})
 const record={...recordDraft('legacy-module','2026-11-14','note'),title:'v2 历史'}
 await old.table('records').add(record);await old.table('local').add({key:'draft',value:'未保存正文'});await old.table('cloudAcks').add({key:'account/op',accountId:'account',operationId:'op'});await old.table('cloudState').add({key:'account',accountId:'account',cursor:'preserved-cursor'});old.close()
 const upgraded=new PocketDatabase(name);databases.push(upgraded);await upgraded.open();expect(await upgraded.records.get(record.id)).toEqual(record);expect((await upgraded.local.get('draft'))?.value).toBe('未保存正文');expect(await upgraded.cloudAcks.count()).toBe(1);expect((await upgraded.cloudState.get('account'))?.cursor).toBe('preserved-cursor');expect(await upgraded.media.count()).toBe(0)
})
async function voice(db:PocketDatabase){const asset=await makeAudio(new Blob([new Uint8Array([0,1,255,128,7])],{type:'audio/mp4'}));const record=await saveAudioRecord({...recordDraft('module-pocket-notes','2026-11-14','note'),title:'语音',properties:{audio_duration_ms:'1234'}},asset,db);return {asset,record}}
it('seeds exactly seven daily projects once and preserves edits and removal after reopen',async()=>{
 const db=database();await initialize(db);expect((await db.routines.orderBy('order').toArray()).map(r=>r.title)).toEqual(['做饭','吃饭','收拾屋','睡觉','休息','学习','运动'])
 const row=(await db.routines.get('daily-cooking'))!;await saveRoutine({...row,title:'我的做饭',archived:true},db);db.close();await db.open();await initialize(db);expect(await db.routines.count()).toBe(7);expect(await db.routines.get(row.id)).toMatchObject({title:'我的做饭',archived:true})
})
it('stores voice bytes and note operation atomically, and preserves them through a portable backup',async()=>{
 const a=database(),b=database();await initialize(a);const {asset,record}=await voice(a),backup=await exportBackup(a);await restoreBackup(backup,b);await restoreBackup(backup,b)
 expect(await b.records.get(record.id)).toEqual(record);expect(await b.media.count()).toBe(1);expect(await mediaDigest(new Uint8Array((await b.media.get(asset.file))!.bytes))).toBe(asset.sha256)
 const broken=structuredClone(backup) as {media:Array<{data:string}>};broken.media[0].data='AAAA';const untouched=database();await expect(restoreBackup(broken,untouched)).rejects.toThrow('完整性');expect(await untouched.records.count()).toBe(0);expect(await untouched.media.count()).toBe(0)
})
it('rolls back both the audio blob and note if operation persistence fails',async()=>{
 const db=database();await initialize(db);db.operations.hook('creating',()=>{throw Error('disk full')});await expect(voice(db)).rejects.toThrow('disk full');expect(await db.records.count()).toBe(0);expect(await db.media.count()).toBe(0)
})
it('exchanges binary voice data in both directions and retries a committed upload with the same ID',async()=>{
 const a=database(),b=database(),remote=new MemoryDrive();await initialize(a);await initialize(b);const first=await voice(a),transport=remote.transport(),create=transport.createAudio!;let lose=true
 transport.createAudio=async(...args)=>{await create(...args);if(lose){lose=false;throw Error('audio response lost')}}
 await expect(sync(a,transport)).rejects.toThrow('lost');expect(remote.audio.size).toBe(1);expect(remote.files.size).toBe(0)
 await sync(a,transport);await sync(b,remote.transport());expect(remote.audio.size).toBe(1);expect(await b.records.get(first.record.id)).toEqual(first.record);expect((await b.media.get(first.asset.file))?.sha256).toBe(first.asset.sha256)
 const second=await voice(b);await sync(b,remote.transport());await sync(a,remote.transport());expect((await a.media.get(second.asset.file))?.sha256).toBe(second.asset.sha256);expect(remote.audio.size).toBe(2)
})
it('keeps a missing/corrupted remote voice as an explicit sync error without losing the text',async()=>{
 const a=database(),b=database(),remote=new MemoryDrive();await initialize(a);await initialize(b);const {record}=await voice(a);await sync(a,remote.transport());remote.audio.clear();await expect(sync(b,remote.transport())).rejects.toThrow('录音尚未上传');expect((await b.records.get(record.id))?.title).toBe(record.title);expect(await b.media.count()).toBe(0)
})
it('propagates removed test sessions as tombstones without resurrection or aggregate time',async()=>{
 const a=database(),b=database(),remote=new MemoryDrive();await initialize(a);const session=await startSession('routine','daily-cooking',100000,a);await endSession(session.id,200000,a);await sync(a,remote.transport());await sync(b,remote.transport())
 const stale=(await b.operations.where('[entity+recordId]').equals(['sessions',session.id]).toArray()) as Operation[]
 await deleteSession(session.id,a);const count=await a.operations.count();await deleteSession(session.id,a);expect(await a.operations.count()).toBe(count);await sync(a,remote.transport());await sync(b,remote.transport());await applyOperations(stale,b,false);expect((await b.sessions.get(session.id))?.deleted).toBe(true);expect(totalMilliseconds(await b.sessions.toArray(),'daily-cooking','1970-01-01')).toBe(0)
})
it('rejects deleting an active timer and preserves other projects when a finished interval is deleted',async()=>{
 const db=database();await initialize(db);const first=await startSession('routine','daily-cooking',100000,db)
 const count=await db.operations.count();await expect(deleteSession(first.id,db)).rejects.toThrow('先停止');expect(await db.operations.count()).toBe(count);expect((await db.sessions.get(first.id))?.deleted).toBeUndefined()
 await endSession(first.id,200000,db);const other=await startSession('routine','daily-studying',300000,db);await endSession(other.id,420000,db)
 await deleteSession(first.id,db);expect(totalMilliseconds(await db.sessions.toArray(),'daily-cooking','1970-01-01')).toBe(0);expect(totalMilliseconds(await db.sessions.toArray(),'daily-studying','1970-01-01')).toBe(120000);expect((await db.sessions.get(other.id))?.deleted).toBeUndefined()
})
