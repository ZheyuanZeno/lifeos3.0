import {afterEach,expect,it} from 'vitest'
import Dexie from 'dexie'
import {PocketDatabase} from '../lifeos/pocket/src/database'
import {initialize,startSession,pauseSession,resumeSession,endSession,exportBackup,restoreBackup,editSession} from '../lifeos/pocket/src/repository'
import {sessionElapsed,sessionMilliseconds,isSessionPaused,isHistorySession} from '../lifeos/pocket/src/time'
import {validateRow,type Session} from '../lifeos/pocket/src/model'
import {sync} from '../lifeos/pocket/src/sync/engine'
import {MemoryDrive} from './sync-memory'
const databases:PocketDatabase[]=[]
function database(name='pause-'+crypto.randomUUID()){const db=new PocketDatabase(name);databases.push(db);return db}
afterEach(async()=>{for(const db of databases.splice(0))await db.delete()})
it('persists pause/resume intervals, excludes paused time and keeps the task lock until explicit end',async()=>{
 const db=database();await initialize(db);const s=await startSession('routine','daily-cooking',100000,db)
 await pauseSession(s.id,140000,db);const count=await db.operations.count();await pauseSession(s.id,150000,db);expect(await db.operations.count()).toBe(count)
 db.close();await db.open();expect(isSessionPaused((await db.sessions.get(s.id))!)).toBe(true);expect(sessionElapsed((await db.sessions.get(s.id))!,240000)).toBe(40000);expect((await db.local.get('activeSession'))?.value).toBe(s.id);await expect(startSession('routine','daily-eating',200000,db)).rejects.toThrow('先结束')
 await resumeSession(s.id,240000,db);const resumed=await db.operations.count();await resumeSession(s.id,250000,db);expect(await db.operations.count()).toBe(resumed)
 await pauseSession(s.id,260000,db);await resumeSession(s.id,280000,db);await endSession(s.id,310000,db)
 const row=(await db.sessions.get(s.id))!;expect(sessionElapsed(row)).toBe(90000);expect(row.pauses).toHaveLength(2);expect(await db.sessions.count()).toBe(1);expect(await db.local.get('activeSession')).toBeUndefined()
})
it('can end while paused and evaluates the 30-second rule against active time',async()=>{
 const db=database();await initialize(db);const short=await startSession('routine','daily-cooking',100000,db);await pauseSession(short.id,125000,db);await endSession(short.id,900000,db)
 const ignored=(await db.sessions.get(short.id))!;expect(sessionElapsed(ignored)).toBe(25000);expect(ignored.deleted).toBe(true);expect(ignored.pauses?.[0].endedAt).toBe(new Date(900000).toISOString())
 const valid=await startSession('routine','daily-cooking',1000000,db);await pauseSession(valid.id,1040000,db);await endSession(valid.id,1900000,db);expect(sessionElapsed((await db.sessions.get(valid.id))!)).toBe(40000);expect(isHistorySession((await db.sessions.get(valid.id))!)).toBe(true)
})
it('preserves a paused timer after invalid clock or failed persistence',async()=>{
 const db=database();await initialize(db);const s=await startSession('routine','daily-cooking',100000,db);await pauseSession(s.id,140000,db)
 await expect(resumeSession(s.id,130000,db)).rejects.toThrow('系统时间');await expect(endSession(s.id,130000,db)).rejects.toThrow('系统时间')
 const fail=()=>{throw Error('disk full')};db.operations.hook('creating',fail);await expect(resumeSession(s.id,200000,db)).rejects.toThrow('disk full');db.operations.hook('creating').unsubscribe(fail);expect(isSessionPaused((await db.sessions.get(s.id))!)).toBe(true);expect((await db.local.get('activeSession'))?.value).toBe(s.id)
})
it('allocates active segments around midnight and retains them when the history bounds are edited',async()=>{
 const db=database();await initialize(db);const start=Date.parse('2026-11-13T22:59:20Z'),s=await startSession('routine','daily-cooking',start,db)
 // Explicitly use Berlin for the civil-day allocation, independent of the test host.
 const row={...(await db.sessions.get(s.id))!,timeZone:'Europe/Berlin'};await db.sessions.put(row)
 await pauseSession(s.id,start+30000,db);await resumeSession(s.id,start+70000,db);await endSession(s.id,start+100000,db)
 const ended=(await db.sessions.get(s.id))!;expect(sessionElapsed(ended)).toBe(60000);expect(sessionMilliseconds(ended,'2026-11-13')).toBe(30000);expect(sessionMilliseconds(ended,'2026-11-14')).toBe(30000)
 await editSession(s.id,new Date(start+10000).toISOString(),new Date(start+90000).toISOString(),db);expect(sessionElapsed((await db.sessions.get(s.id))!)).toBe(40000)
})
it('validates pause ordering, closed-session bounds and rejects overlapping pauses',()=>{
 const row:Session={id:'s',subjectId:'daily-cooking',subjectKind:'routine',title:'做饭',deviceId:'device',startedAt:'2026-11-14T08:00:00Z',endedAt:'2026-11-14T09:00:00Z',timeZone:'UTC',created_at:'2026-11-14T08:00:00Z',updated_at:'2026-11-14T09:00:00Z'}
 expect(()=>validateRow('sessions',{...row,pauses:[{startedAt:'2026-11-14T08:10:00Z',endedAt:null}]})).toThrow('暂停')
 expect(()=>validateRow('sessions',{...row,pauses:[{startedAt:'2026-11-14T07:59:00Z',endedAt:'2026-11-14T08:10:00Z'}]})).toThrow('暂停')
 expect(()=>validateRow('sessions',{...row,pauses:[{startedAt:'2026-11-14T08:10:00Z',endedAt:'2026-11-14T08:30:00Z'},{startedAt:'2026-11-14T08:20:00Z',endedAt:'2026-11-14T08:40:00Z'}]})).toThrow('暂停')
})
it('restores and controls a shared paused session while preserving its originating device, then syncs duration',async()=>{
 const a=database(),b=database(),restored=database(),remote=new MemoryDrive();await initialize(a);await initialize(b);const s=await startSession('routine','daily-cooking',100000,a);await pauseSession(s.id,140000,a)
 await restoreBackup(await exportBackup(a),restored);expect(isSessionPaused((await restored.sessions.get(s.id))!)).toBe(true);expect(await restored.local.get('activeSession')).toBeUndefined();await resumeSession(s.id,200000,restored);expect(isSessionPaused((await restored.sessions.get(s.id))!)).toBe(false);expect((await restored.sessions.get(s.id))?.deviceId).toBe(s.deviceId)
 await sync(a,remote.transport());await sync(b,remote.transport());expect(sessionElapsed((await b.sessions.get(s.id))!,200000)).toBe(40000)
 await resumeSession(s.id,240000,a);await endSession(s.id,290000,a);await sync(a,remote.transport());await sync(b,remote.transport());expect(sessionElapsed((await b.sessions.get(s.id))!)).toBe(90000)
})
it('upgrades v3 sessions and media in place without replacing the active timer',async()=>{
 const name='pause-upgrade-'+crypto.randomUUID(),old=new Dexie(name);old.version(3).stores({modules:'id, kind',records:'id, date, module_id, type, [type+date]',routines:'id, order',completions:'id, date, routineId',sessions:'id, subjectId, startedAt, endedAt',operations:'id, uploaded, deviceId, &[deviceId+sequence], [entity+recordId]',local:'key',cloudAcks:'key, accountId, operationId',cloudFiles:'key, accountId, fileId',cloudBatches:'key, accountId, [accountId+status]',cloudState:'key',media:'file',remoteMedia:'key, accountId'})
 const row={id:'legacy',subjectId:'daily-cooking',subjectKind:'routine',title:'做饭',deviceId:'device',startedAt:'2026-11-14T08:00:00Z',endedAt:null,timeZone:'UTC',created_at:'2026-11-14T08:00:00Z',updated_at:'2026-11-14T08:00:00Z'}
 await old.table('sessions').put(row);await old.table('local').put({key:'activeSession',value:row.id});await old.table('media').put({file:'audio',bytes:new Uint8Array([1,2,3]).buffer});old.close()
 const upgraded=database(name);await upgraded.open();expect(upgraded.verno).toBe(5);expect(await upgraded.sessions.get(row.id)).toEqual(row);expect((await upgraded.local.get('activeSession'))?.value).toBe(row.id);expect((await upgraded.media.get('audio'))?.bytes.byteLength).toBe(3)
})
