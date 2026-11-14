import {afterEach,expect,it} from 'vitest'
import {PocketDatabase} from '../lifeos/pocket/src/database'
import {initialize,reorderRoutines,saveRoutine,startSession,pauseSession,endSession,saveSessionNote,exportBackup,restoreBackup} from '../lifeos/pocket/src/repository'
import {sessionElapsed,isSessionPaused} from '../lifeos/pocket/src/time'
import {sync} from '../lifeos/pocket/src/sync/engine'
import {MemoryDrive} from './sync-memory'
const databases:PocketDatabase[]=[]
function database(){const db=new PocketDatabase('interaction-'+crypto.randomUUID());databases.push(db);return db}
afterEach(async()=>{for(const db of databases.splice(0))await db.delete()})
const order=async(db:PocketDatabase)=>(await db.routines.orderBy('order').toArray()).filter(r=>!r.archived&&!r.deleted).map(r=>r.id)

it('persists a reordered visible subset, preserves hidden slots and project metadata, and roundtrips backup',async()=>{
 const db=database();await initialize(db);const initial=await order(db),row=(await db.routines.get(initial[0]))!;await saveRoutine({...row,days:[1,3],title:'保留我的名称'},db)
 await reorderRoutines([initial[2],initial[0]],db);const expected=[initial[2],initial[1],initial[0],...initial.slice(3)];expect(await order(db)).toEqual(expected);expect((await db.routines.get(row.id))?.days).toEqual([1,3]);expect((await db.routines.get(row.id))?.title).toBe('保留我的名称')
 db.close();await db.open();expect(await order(db)).toEqual(expected);const restored=database();await restoreBackup(await exportBackup(db),restored);expect(await order(restored)).toEqual(expected)
})

it('rejects stale/duplicate reorder targets and rolls the whole reorder back if its operation write fails',async()=>{
 const db=database();await initialize(db);const ids=await order(db),count=await db.operations.count();await expect(reorderRoutines([ids[0],ids[0]],db)).rejects.toThrow('变化');await expect(reorderRoutines(['missing'],db)).rejects.toThrow('变化')
 await reorderRoutines(ids,db);expect(await db.operations.count()).toBe(count)
 const fail=()=>{throw Error('disk full')};db.operations.hook('creating',fail);await expect(reorderRoutines([...ids].reverse(),db)).rejects.toThrow('disk full');db.operations.hook('creating').unsubscribe(fail);expect(await order(db)).toEqual(ids);expect(await db.operations.count()).toBe(count)
})

it('syncs routine order without overriding a concurrent name or repeat-day edit',async()=>{
 const a=database(),b=database(),remote=new MemoryDrive();await initialize(a);await initialize(b);await sync(a,remote.transport());await sync(b,remote.transport());const ids=await order(a),row=(await b.routines.get(ids[0]))!;await saveRoutine({...row,title:'我的做饭项目',days:[2,4]},b);await reorderRoutines([...ids].reverse(),a)
 await sync(a,remote.transport());await sync(b,remote.transport());await sync(a,remote.transport());expect(await order(b)).toEqual([...ids].reverse());expect((await a.routines.get(row.id))?.title).toBe('我的做饭项目');expect((await a.routines.get(row.id))?.days).toEqual([2,4])
})

it('edits a running or paused note without ending the timer, then retains it in history, backup and cloud',async()=>{
 const a=database(),b=database(),remote=new MemoryDrive();await initialize(a);const s=await startSession('routine','daily-studying',100000,a)
 await saveSessionNote(s.id,'第一章\n随时补充',a,'');await pauseSession(s.id,140000,a);await saveSessionNote(s.id,'暂停后补充',a,'第一章\n随时补充');expect(isSessionPaused((await a.sessions.get(s.id))!)).toBe(true);expect((await a.local.get('activeSession'))?.value).toBe(s.id)
 await sync(a,remote.transport());await sync(b,remote.transport());expect((await b.sessions.get(s.id))?.note).toBe('暂停后补充');await saveSessionNote(s.id,'另一台补充',b);expect((await b.sessions.get(s.id))?.note).toBe('另一台补充');expect((await b.sessions.get(s.id))?.deviceId).toBe(s.deviceId)
 await endSession(s.id,300000,a);const ended=(await a.sessions.get(s.id))!;expect(ended.note).toBe('暂停后补充');expect(sessionElapsed(ended)).toBe(40000);const restored=database();await restoreBackup(await exportBackup(a),restored);expect((await restored.sessions.get(s.id))?.note).toBe('暂停后补充')
})

it('rejects stale note edits and invalid writes while preserving the active timer',async()=>{
 const db=database();await initialize(db);const s=await startSession('routine','daily-studying',100000,db);await saveSessionNote(s.id,'新版本',db,'');await expect(saveSessionNote(s.id,'旧窗口',db,'')).rejects.toThrow('其他窗口');await expect(saveSessionNote(s.id,'x'.repeat(10001),db)).rejects.toThrow('备注');expect((await db.sessions.get(s.id))?.note).toBe('新版本');expect((await db.sessions.get(s.id))?.endedAt).toBeNull();expect((await db.local.get('activeSession'))?.value).toBe(s.id)
})
