import {afterEach,expect,it} from 'vitest'
import Dexie from 'dexie'
import {PocketDatabase} from '../lifeos/pocket/src/database'
import {initialize,startSession,endSession,editSession,deleteSession,exportBackup,restoreBackup} from '../lifeos/pocket/src/repository'
import {sessionElapsed} from '../lifeos/pocket/src/time'
import {sync} from '../lifeos/pocket/src/sync/engine'
import {MemoryDrive} from './sync-memory'
const databases:PocketDatabase[]=[]
function database(name='session-notes-'+crypto.randomUUID()){const db=new PocketDatabase(name);databases.push(db);return db}
afterEach(async()=>{for(const db of databases.splice(0))await db.delete()})
async function ended(db:PocketDatabase,at=100000){await initialize(db);const s=await startSession('routine','daily-studying',at,db);await endSession(s.id,at+60000,db);return (await db.sessions.get(s.id))!}

it('keeps independent per-session notes, preserves them on time-only edits and backs up multiline text',async()=>{
 const db=database(),a=await ended(db),b=await ended(db,200000),note='学习第 3 章\n复习 <script> 与 😀'
 await editSession(a.id,a.startedAt,a.endedAt!,db,note)
 await editSession(a.id,a.startedAt,new Date(165000).toISOString(),db)
 db.close();await db.open();expect((await db.sessions.get(a.id))?.note).toBe(note);expect((await db.sessions.get(b.id))?.note).toBeUndefined();expect(sessionElapsed((await db.sessions.get(a.id))!)).toBe(65000)
 const restored=database();await restoreBackup(await exportBackup(db),restored);expect((await restored.sessions.get(a.id))?.note).toBe(note)
 await editSession(a.id,a.startedAt,a.endedAt!,db,'');expect((await db.sessions.get(a.id))?.note).toBe('')
})

it('syncs new notes, explicit clearing and deleted sessions without resurrecting their history',async()=>{
 const a=database(),b=database(),remote=new MemoryDrive(),s=await ended(a);await initialize(b)
 await editSession(s.id,s.startedAt,s.endedAt!,a,'第一段备注');await sync(a,remote.transport());await sync(b,remote.transport());expect((await b.sessions.get(s.id))?.note).toBe('第一段备注')
 await editSession(s.id,s.startedAt,s.endedAt!,b,'');await sync(b,remote.transport());await sync(a,remote.transport());expect((await a.sessions.get(s.id))?.note).toBe('')
 await deleteSession(s.id,a);await sync(a,remote.transport());await sync(b,remote.transport());expect((await b.sessions.get(s.id))?.deleted).toBe(true)
})

it('rejects invalid notes and rolls back failed writes without altering time or logs',async()=>{
 const db=database(),s=await ended(db),before=await db.operations.count()
 for(const note of [null,42,'x'.repeat(10001)])await expect(editSession(s.id,s.startedAt,s.endedAt!,db,note as string)).rejects.toThrow('备注')
 const fail=()=>{throw Error('disk full')};db.operations.hook('creating',fail);await expect(editSession(s.id,s.startedAt,s.endedAt!,db,'未保存')).rejects.toThrow('disk full');db.operations.hook('creating').unsubscribe(fail)
 expect(await db.sessions.get(s.id)).toEqual(s);expect(await db.operations.count()).toBe(before)
})

it('upgrades populated v4 data in place with timer state, cloud confirmations and audio unchanged',async()=>{
 const name='notes-upgrade-'+crypto.randomUUID(),source=database(name),s=await ended(source),snapshot=await exportBackup(source);source.close()
 // Persist a genuine previous-version database, including all existing stores.
 const old=new Dexie(name+'-v4');old.version(4).stores({modules:'id, kind',records:'id, date, module_id, type, [type+date]',routines:'id, order',completions:'id, date, routineId',sessions:'id, subjectId, startedAt, endedAt',operations:'id, uploaded, deviceId, &[deviceId+sequence], [entity+recordId]',local:'key',cloudAcks:'key, accountId, operationId',cloudFiles:'key, accountId, fileId',cloudBatches:'key, accountId, [accountId+status]',cloudState:'key',media:'file',remoteMedia:'key, accountId'})
 await old.table('sessions').put(s);await old.table('operations').bulkPut(snapshot.operations as object[]);await old.table('local').put({key:'identity',value:{id:'same-device',sequence:5,clock:8}});await old.table('cloudState').put({key:'same-account',value:'same-cursor'});await old.table('media').put({file:'same-audio',bytes:new Uint8Array([1,2,3]).buffer});old.close()
 const upgraded=database(name+'-v4');await upgraded.open();expect(upgraded.verno).toBe(5);expect(await upgraded.sessions.get(s.id)).toEqual(s);expect(await upgraded.operations.count()).toBe((snapshot.operations as object[]).length);expect((await upgraded.local.get('identity'))?.value).toEqual({id:'same-device',sequence:5,clock:8});expect(await upgraded.cloudState.get('same-account')).toEqual({key:'same-account',value:'same-cursor'});expect(new Uint8Array((await upgraded.media.get('same-audio'))!.bytes)).toEqual(new Uint8Array([1,2,3]))
})
