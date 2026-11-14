import { afterEach, describe, expect, it } from 'vitest'
import { PocketDatabase } from '../lifeos/pocket/src/database'
import { initialize, saveRoutine, setCompletion, startSession, endSession, editSession, applyOperations, exportBackup, restoreBackup, recordDraft, saveRecord, getIdentity } from '../lifeos/pocket/src/repository'
import { totalMilliseconds, sessionMilliseconds, dayRange, isHistorySession, dayAt } from '../lifeos/pocket/src/time'
import { materialize } from '../lifeos/pocket/src/merge'
import type { Routine, Session } from '../lifeos/pocket/src/model'
const databases:PocketDatabase[]=[]
function database(name='test-'+crypto.randomUUID()){const db=new PocketDatabase(name);databases.push(db);return db}
afterEach(async()=>{for(const db of databases.splice(0))await db.delete()})
const routine=(title='学习')=>({title,icon:'◷',category:'专业课',days:[0,1,2,3,4,5,6],minimumMinutes:null,targetMinutes:30,order:0,archived:false})
const at=(s:string)=>Date.parse(s)

describe('local transactions and timer recovery',()=>{
 it('persists a running timer across close/open and saves pause only once',async()=>{
  const db=database();await initialize(db);const r=await saveRoutine(routine(),db);const session=await startSession('routine',r.id,at('2026-11-13T09:00:00Z'),db);db.close();await db.open()
  expect((await db.local.get('activeSession'))?.value).toBe(session.id)
  await Promise.all([endSession(session.id,at('2026-11-13T09:25:00Z'),db),endSession(session.id,at('2026-11-13T09:25:00Z'),db)])
  expect(await db.sessions.count()).toBe(1);expect(await db.local.get('activeSession')).toBeUndefined()
  const rows=await db.sessions.toArray();expect(totalMilliseconds(rows,r.id,'2026-11-13')).toBe(25*60000)
  expect((await db.completions.toArray())).toHaveLength(0)
 })
 it('serializes duplicate starts per project while allowing another project to run independently',async()=>{
  const db=database();await initialize(db);const a=await saveRoutine(routine('A'),db),b=await saveRoutine(routine('B'),db)
  const starts=await Promise.all([startSession('routine',a.id,100000,db),startSession('routine',a.id,100000,db)])
  expect(starts[0].id).toBe(starts[1].id)
  const next=await startSession('routine',b.id,140000,db)
  expect((await db.sessions.toArray()).filter(s=>!s.endedAt)).toHaveLength(2)
  await endSession(starts[0].id,200000,db)
  expect((await db.sessions.get(next.id))?.endedAt).toBeNull();expect((await db.local.get('activeSession'))?.value).toBe(next.id)
  expect((await startSession('routine',b.id,210000,db)).id).toBe(next.id)
  await endSession(next.id,240000,db);expect(await db.local.get('activeSession')).toBeUndefined()
 })
 it('keeps completion separate from timing and retains yesterday after a new day',async()=>{
  const db=database();await initialize(db);const r=await saveRoutine(routine(),db)
  await setCompletion(r.id,'2026-11-13',true,db);await setCompletion(r.id,'2026-11-14',false,db)
  expect((await db.completions.get(r.id+'_2026-11-13'))?.completed).toBe(true)
  expect(await db.sessions.count()).toBe(0)
 })
 it('rolls back the business write if its outbox write fails',async()=>{
  const db=database();await initialize(db);const before=await db.routines.count();const fail=()=>{throw Error('disk full')};db.operations.hook('creating',fail)
  await expect(saveRoutine(routine(),db)).rejects.toThrow('disk full')
  db.operations.hook('creating').unsubscribe(fail);expect(await db.routines.count()).toBe(before)
 })
 it('rejects invalid recurrence and preserves a running session after a backward clock change',async()=>{
  const db=database();await initialize(db);await expect(saveRoutine({...routine(),days:[]},db)).rejects.toThrow()
  const r=await saveRoutine(routine(),db),s=await startSession('routine',r.id,200000,db)
  await expect(endSession(s.id,100000,db)).rejects.toThrow('系统时间')
  expect((await db.sessions.get(s.id))?.endedAt).toBeNull()
 })
 it('validates planned time and edits completed sessions without duplicates',async()=>{
  const db=database();await initialize(db);const record={...recordDraft('module-plans','2026-11-13'),title:'课题',properties:{planned_start:'2026-11-13T09:00:00Z',planned_end:'2026-11-13T08:00:00Z'}}
  await expect(saveRecord(record,db)).rejects.toThrow('结束时间')
  const r=await saveRoutine(routine(),db),s=await startSession('routine',r.id,100000,db)
  await endSession(s.id,200000,db);await editSession(s.id,new Date(110000).toISOString(),new Date(190000).toISOString(),db)
  expect(await db.sessions.count()).toBe(1)
 })
})
function session(startedAt:string,endedAt:string,timeZone='Europe/Berlin'):Session{return {id:'session',subjectId:'routine',subjectKind:'routine',title:'学习',deviceId:'device',startedAt,endedAt,timeZone,created_at:startedAt,updated_at:endedAt}}
describe('civil days and DST',()=>{
 it('splits a midnight-spanning session without losing elapsed time',()=>{
  const s=session('2026-11-13T22:50:00Z','2026-11-13T23:20:00Z')
  expect(sessionMilliseconds(s,'2026-11-13')).toBe(10*60000);expect(sessionMilliseconds(s,'2026-11-14')).toBe(20*60000)
 })
 it('handles the 23-hour spring and 25-hour autumn civil day',()=>{
  const spring=dayRange('2026-03-29','Europe/Berlin'),autumn=dayRange('2026-10-25','Europe/Berlin')
  expect(spring[1]-spring[0]).toBe(23*3600000);expect(autumn[1]-autumn[0]).toBe(25*3600000)
 })
 it('allocates in the stored timezone and deduplicates session IDs',()=>{
  const s=session('2026-11-13T23:00:00Z','2026-11-14T00:00:00Z','America/New_York')
  expect(totalMilliseconds([s,s],'routine','2026-11-13')).toBe(3600000)
  expect(totalMilliseconds([s],'routine','2026-11-14')).toBe(0)
 })
})
describe('portable history and idempotent merge',()=>{
 it('restores full history twice without duplicating rows or taking over a foreign timer',async()=>{
  const a=database(),b=database();await initialize(a);await initialize(b);const r=await saveRoutine(routine(),a);await startSession('routine',r.id,100000,a)
  const backup=await exportBackup(a);await restoreBackup(backup,b);await restoreBackup(backup,b)
  expect(await b.routines.count()).toBe((backup.routines as Routine[]).length);expect(await b.sessions.count()).toBe(1);expect(await b.operations.where('uploaded').equals(0).count()).toBeGreaterThan(2);expect(await b.local.get('activeSession')).toBeUndefined()
  expect((await getIdentity(a)).id).not.toBe((await getIdentity(b)).id)
 })
 it('merges two offline devices in either order and retains concurrent note versions',async()=>{
  const a=database(),b=database();await initialize(a);await initialize(b)
  const note=await saveRecord({...recordDraft('module-pocket-notes','2026-11-13','note'),title:'想法',body:'原文'},a)
  await applyOperations(await a.operations.toArray(),b)
  await saveRecord({...note,body:'设备 A 版本'},a);await saveRecord({...note,body:'设备 B 版本'},b)
  const ao=await a.operations.toArray(),bo=await b.operations.toArray();await applyOperations(bo,a);await applyOperations(ao,b)
  expect((await a.records.get(note.id))?.body).toBe((await b.records.get(note.id))?.body)
  const merged=materialize((await a.operations.toArray()).filter(o=>o.recordId===note.id));expect(merged.conflicts.find(c=>c.field==='body')?.versions).toHaveLength(2)
  // Independent title/body updates merge by field, not by whole-record replacement.
  await saveRecord({...(await a.records.get(note.id))!,title:'新标题'},a)
  await applyOperations(await a.operations.toArray(),b);expect((await b.records.get(note.id))?.title).toBe('新标题')
 })
 it('does not revive a deleted record from a stale offline edit, but permits an observed restore',async()=>{
  const a=database(),b=database();await initialize(a);await initialize(b)
  const row=await saveRecord({...recordDraft('module-plans','2026-11-13'),title:'计划'},a);await applyOperations(await a.operations.toArray(),b)
  await saveRecord({...row,deleted:true},a);await saveRecord({...row,title:'离线旧版本'},b)
  await applyOperations(await b.operations.toArray(),a);expect((await a.records.get(row.id))?.deleted).toBe(true)
  await saveRecord({...(await a.records.get(row.id))!,deleted:false},a);expect((await a.records.get(row.id))?.deleted).toBe(false)
 })
 it('rejects malformed backup without partially importing it',async()=>{
  const a=database(),b=database();await initialize(a);await initialize(b);await saveRoutine(routine(),a);const backup=await exportBackup(a)
  const before=await b.operations.count();await expect(restoreBackup({...backup,schemaVersion:99},b)).rejects.toThrow()
  const malformed=structuredClone(backup);(malformed.routines as Routine[])[0].title='tampered';await expect(restoreBackup(malformed,b)).rejects.toThrow('不一致');expect(await b.operations.count()).toBe(before)
 })
 it('rejects a conflicting operation ID, reordered JSON keys are still idempotent',async()=>{
  const a=database(),b=database();await initialize(a);await initialize(b);const ops=await a.operations.toArray();await applyOperations(ops,b)
  await applyOperations(ops.map(o=>Object.fromEntries(Object.entries(o).reverse())),b)
  await expect(applyOperations([{...ops[0],patch:{...ops[0].patch,name:'破坏版本'}}],b)).rejects.toThrow('编号冲突')
 })
 it('rejects cyclic or invalid causal claims before writing',async()=>{
  const db=database();await initialize(db);const op=(await db.operations.toArray())[0];await expect(applyOperations([{...op,id:'malformed',context:{[op.deviceId]:op.sequence}}],db)).rejects.toThrow('因果')
 })
})

for(const elapsed of [0,29999,30000,30001])it('keeps the exact 30-second boundary: '+elapsed+'ms',async()=>{
 const db=database();await initialize(db);const s=await startSession('routine','daily-cooking',100000,db);await endSession(s.id,100000+elapsed,db)
 const row=(await db.sessions.get(s.id))!;expect(!!row.deleted).toBe(elapsed<=30000);expect(isHistorySession(row)).toBe(elapsed>30000);expect(await db.local.get('activeSession')).toBeUndefined();expect(sessionMilliseconds(row,dayAt(100000,row.timeZone))).toBe(elapsed>30000?elapsed:0)
 const count=await db.operations.count();await endSession(s.id,100000+elapsed,db);expect(await db.operations.count()).toBe(count)
})
it('ignores legacy short history without rewriting its data, and filters an edited interval shortened to 30 seconds',async()=>{
 const legacy=session('2026-11-13T09:00:00Z','2026-11-13T09:00:30Z');expect(isHistorySession(legacy)).toBe(false);expect(sessionMilliseconds(legacy,'2026-11-13')).toBe(0);expect(legacy.deleted).toBeUndefined()
 const db=database();await initialize(db);const s=await startSession('routine','daily-cooking',100000,db);await endSession(s.id,200000,db);await editSession(s.id,new Date(100000).toISOString(),new Date(130000).toISOString(),db);expect((await db.sessions.get(s.id))?.deleted).toBe(true)
})
it('applies the threshold to the whole interval, retaining each day of a valid midnight-spanning interval',()=>{
 const s=session('2026-11-13T22:59:40Z','2026-11-13T23:00:20Z');expect(isHistorySession(s)).toBe(true);expect(sessionMilliseconds(s,'2026-11-13')).toBe(20000);expect(sessionMilliseconds(s,'2026-11-14')).toBe(20000)
})
