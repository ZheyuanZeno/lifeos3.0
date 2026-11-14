import {afterEach,expect,it} from 'vitest'
import {PocketDatabase} from '../lifeos/pocket/src/database'
import {initialize,startSession,pauseSession,resumeSession,endSession,saveSessionNote,applyOperations,exportBackup,restoreBackup,savePlan,setRecordCompletion} from '../lifeos/pocket/src/repository'
import {openSessions} from '../lifeos/pocket/src/shared-timer'
import {materialize} from '../lifeos/pocket/src/merge'
import {isSessionPaused,sessionElapsed} from '../lifeos/pocket/src/time'
import {validateRow,type Session} from '../lifeos/pocket/src/model'
const databases:PocketDatabase[]=[]
function database(){const db=new PocketDatabase('shared-timer-'+crypto.randomUUID());databases.push(db);return db}
afterEach(async()=>{for(const db of databases.splice(0))await db.delete()})
async function pair(){const a=database(),b=database();await initialize(a);const s=await startSession('routine','daily-studying',100000,a);await applyOperations(await a.operations.toArray(),b);return {a,b,s}}
async function converge(a:PocketDatabase,b:PocketDatabase){const incoming=[...await a.operations.toArray(),...await b.operations.toArray()],unique=[...new Map(incoming.map(o=>[o.id,o])).values()];await applyOperations(unique,a);await applyOperations([...unique].reverse(),b)}

it('lets another device pause, annotate, resume and end the same ID without duplicating that project timer',async()=>{
 const {a,b,s}=await pair();expect(await b.local.get('activeSession')).toBeUndefined();expect(openSessions(await b.sessions.toArray())[0].id).toBe(s.id);expect((await startSession('routine','daily-studying',140000,b)).id).toBe(s.id)
 await pauseSession(s.id,140000,b);await saveSessionNote(s.id,'另一台手机备注',b);await converge(a,b);expect(isSessionPaused((await a.sessions.get(s.id))!)).toBe(true)
 await resumeSession(s.id,240000,a);await converge(a,b);await endSession(s.id,300000,b);await converge(a,b);for(const db of [a,b]){const row=(await db.sessions.get(s.id))!;expect(row.deviceId).toBe(s.deviceId);expect(row.note).toBe('另一台手机备注');expect(sessionElapsed(row)).toBe(100000);expect(openSessions(await db.sessions.toArray())).toHaveLength(0);expect(await db.sessions.count()).toBe(1)}
})

it('ending wins a concurrent pause and stale resume without reopening or constructing an invalid pause/end pair',async()=>{
 const {a,b,s}=await pair();await pauseSession(s.id,140000,a);await converge(a,b);await resumeSession(s.id,240000,a);await endSession(s.id,180000,b);await converge(a,b)
 for(const db of [a,b]){const row=(await db.sessions.get(s.id))!;expect(row.endedAt).toBe(new Date(180000).toISOString());expect(row.pauses?.[0].endedAt).toBe(new Date(180000).toISOString());expect(sessionElapsed(row)).toBe(40000);expect(()=>validateRow('sessions',row)).not.toThrow()}
 await expect(resumeSession(s.id,300000,a)).rejects.toThrow('已结束');expect(await a.sessions.get(s.id)).toEqual(await b.sessions.get(s.id))
})

it('preserves a concurrent note while a stop rejects an unrelated later pause snapshot',async()=>{
 const {a,b,s}=await pair();await endSession(s.id,200000,a);await pauseSession(s.id,150000,b);await saveSessionNote(s.id,'停止时保留备注',b);await converge(a,b);const row=(await a.sessions.get(s.id))!;expect(row.endedAt).toBe(new Date(200000).toISOString());expect(row.pauses).toBeUndefined();expect(row.note).toBe('停止时保留备注');expect(sessionElapsed(row)).toBe(100000);expect(row).toEqual(await b.sessions.get(s.id))
})

it('keeps concurrent offline starts visible and addressable without deleting either record',async()=>{
 const a=database(),b=database();await initialize(a);await initialize(b);const one=await startSession('routine','daily-studying',100000,a),two=await startSession('routine','daily-cooking',100000,b);await converge(a,b);expect(openSessions(await a.sessions.toArray()).map(s=>s.id)).toEqual(openSessions(await b.sessions.toArray()).map(s=>s.id));expect(openSessions(await a.sessions.toArray())).toHaveLength(2);await endSession(two.id,180000,a);await converge(a,b);expect(openSessions(await b.sessions.toArray()).map(s=>s.id)).toEqual([one.id]);expect(await b.sessions.count()).toBe(2)
})

it('lets a remote plan completion close its shared timer atomically and still discard short sessions',async()=>{
 const a=database(),b=database();await initialize(a);const p=await savePlan({title:'共享计划',date:'2026-11-14',body:''},a),s=await startSession('record',p.id,100000,a);await applyOperations(await a.operations.toArray(),b);await setRecordCompletion(p.id,true,b,125000);await converge(a,b);expect((await a.records.get(p.id))?.status).toBe('done');expect((await a.sessions.get(s.id))?.deleted).toBe(true);expect(openSessions(await a.sessions.toArray())).toHaveLength(0)
})

it('restores a validated legacy concurrent-edit backup using current terminal snapshot semantics',async()=>{
 const {a,b,s}=await pair();await endSession(s.id,200000,a);await pauseSession(s.id,140000,b);await resumeSession(s.id,160000,b);const operations=[...new Map([...await a.operations.toArray(),...await b.operations.toArray()].map(o=>[o.id,o])).values()],history=operations.filter(o=>o.entity==='sessions'&&o.recordId===s.id),legacy=materialize(history,true).row as unknown as Session
 expect(()=>validateRow('sessions',legacy)).not.toThrow();const backup=await exportBackup(a);backup.operations=operations;backup.sessions=[legacy];const restored=database();await restoreBackup(backup,restored);expect((await restored.sessions.get(s.id))?.endedAt).toBe(new Date(200000).toISOString());expect(sessionElapsed((await restored.sessions.get(s.id))!)).toBe(100000)
})
