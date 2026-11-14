import {afterEach,expect,it} from 'vitest'
import {PocketDatabase} from '../lifeos/pocket/src/database'
import {initialize,startSession,pauseSession,resumeSession,endSession,savePlan,saveRecord,saveSessionNote,setRecordCompletion,exportBackup,restoreBackup} from '../lifeos/pocket/src/repository'
import {openSessions} from '../lifeos/pocket/src/shared-timer'
import {sessionElapsed,planMilliseconds} from '../lifeos/pocket/src/time'
import {projectReminders,reminderSchedule,validateProjection} from '../lifeos/pocket/src/notifications/projection'
import {sync} from '../lifeos/pocket/src/sync/engine'
import {MemoryDrive} from './sync-memory'
const databases:PocketDatabase[]=[]
function database(){const db=new PocketDatabase('multitimer-'+crypto.randomUUID());databases.push(db);return db}
afterEach(async()=>{for(const db of databases.splice(0))await db.delete()})
const legacy=JSON.stringify({version:1,id:'old-flow',startedAt:new Date(100000).toISOString(),steps:[{id:'wash',title:'洗涤',minutes:60,startedAt:new Date(140000).toISOString(),expectedEndAt:new Date(3740000).toISOString()}]})

it('runs routines and plans concurrently with independent pause, remarks, completion and elapsed time',async()=>{
 const db=database();await initialize(db);const p=await savePlan({title:'洗衣服',date:'2026-11-14',body:''},db)
 const laundry=await startSession('record',p.id,100000,db),study=await startSession('routine','daily-studying',120000,db),cook=await startSession('routine','daily-cooking',140000,db)
 await pauseSession(study.id,160000,db);await saveSessionNote(study.id,'阅读第一章',db);await saveSessionNote(laundry.id,'衣物已放入洗衣机',db)
 expect(openSessions(await db.sessions.toArray())).toHaveLength(3);expect(sessionElapsed((await db.sessions.get(study.id))!,500000)).toBe(40000)
 await setRecordCompletion(p.id,true,db,200000);expect((await db.sessions.get(laundry.id))?.endedAt).not.toBeNull();expect(openSessions(await db.sessions.toArray()).map(s=>s.id).sort()).toEqual([study.id,cook.id].sort())
 await resumeSession(study.id,220000,db);await endSession(cook.id,240000,db);await endSession(study.id,260000,db)
 expect(sessionElapsed((await db.sessions.get(study.id))!)).toBe(80000);expect(sessionElapsed((await db.sessions.get(cook.id))!)).toBe(100000);expect(planMilliseconds(await db.sessions.toArray(),p.id)).toBe(100000)
 expect((await db.sessions.get(laundry.id))?.note).toBe('衣物已放入洗衣机');expect((await db.sessions.get(study.id))?.note).toBe('阅读第一章')
})
it('serializes simultaneous starts per project and the short-record rule affects only the chosen timer',async()=>{
 const db=database();await initialize(db)
 const [a,duplicate,b]=await Promise.all([startSession('routine','daily-studying',100000,db),startSession('routine','daily-studying',100000,db),startSession('routine','daily-cooking',100000,db)])
 expect(a.id).toBe(duplicate.id);expect(await db.sessions.count()).toBe(2)
 await endSession(a.id,130000,db);expect((await db.sessions.get(a.id))?.deleted).toBe(true);expect((await db.sessions.get(b.id))?.endedAt).toBeNull();await endSession(b.id,140000,db);expect((await db.sessions.get(b.id))?.deleted).not.toBe(true)
})
it('restores several timers and manually exchanges independent controls without ending the other project',async()=>{
 const a=database(),b=database(),restored=database(),remote=new MemoryDrive();await initialize(a)
 const study=await startSession('routine','daily-studying',100000,a),cook=await startSession('routine','daily-cooking',110000,a);await pauseSession(study.id,140000,a)
 await restoreBackup(await exportBackup(a),restored);expect(openSessions(await restored.sessions.toArray())).toHaveLength(2);expect(await restored.local.get('activeSession')).toBeUndefined()
 await sync(a,remote.transport());await sync(b,remote.transport());await endSession(cook.id,170000,b);await resumeSession(study.id,180000,b);await sync(b,remote.transport());await sync(a,remote.transport())
 expect(openSessions(await a.sessions.toArray()).map(s=>s.id)).toEqual([study.id]);expect((await a.sessions.get(study.id))?.pauses?.[0].endedAt).toBe(new Date(180000).toISOString());expect((await a.sessions.get(cook.id))?.endedAt).toBe(new Date(170000).toISOString())
})
it('keeps legacy workflow records and backups as ordinary editable plans without stage locks or stage reminders',async()=>{
 const db=database(),restored=database();await initialize(db)
 const draft=await savePlan({title:'原来的洗衣计划',date:'2026-11-14',body:'保留备注'},db),p=await saveRecord({...draft,properties:{background_flow:legacy}},db)
 await restoreBackup(await exportBackup(db),restored);const study=await startSession('routine','daily-studying',4000000,restored),laundry=await startSession('record',p.id,4000000,restored)
 expect(openSessions(await restored.sessions.toArray())).toHaveLength(2);await savePlan({id:p.id,title:'洗衣服',date:p.date,body:p.body},restored);await setRecordCompletion(p.id,true,restored,4100000)
 expect((await restored.sessions.get(study.id))?.endedAt).toBeNull();expect((await restored.sessions.get(laundry.id))?.endedAt).not.toBeNull();expect((await restored.records.get(p.id))?.properties.background_flow).toBe(legacy)
 const ops=await db.operations.toArray(),projection=projectReminders(ops);validateProjection(projection);expect(projection.find(o=>(o.patch.properties as Record<string,string>|undefined)?.background_flow)?.patch.properties).toEqual({background_flow:legacy});expect(reminderSchedule(projection)).toEqual([])
 // Backend must also ignore valid legacy projections already stored by the previous app.
 const old=projection.map(o=>o.entity==='records'&&o.recordId===p.id&&o.patch.properties?{...o,patch:{...o.patch,properties:{background_flow:legacy}}}:o)
 validateProjection(old);expect(reminderSchedule(old)).toEqual([])
})
