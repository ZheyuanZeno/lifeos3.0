import {afterEach,expect,it} from 'vitest'
import {PocketDatabase} from '../lifeos/pocket/src/database'
import {initialize,savePlan,saveRecord,recordDraft,startSession,pauseSession,resumeSession,endSession,setRecordCompletion,exportBackup,restoreBackup} from '../lifeos/pocket/src/repository'
import {planMilliseconds,isSessionPaused} from '../lifeos/pocket/src/time'
import {plansForDate} from '../lifeos/pocket/src/plans'
import {sync} from '../lifeos/pocket/src/sync/engine'
import {MemoryDrive} from './sync-memory'
const databases:PocketDatabase[]=[]
function database(){const db=new PocketDatabase('plans-'+crypto.randomUUID());databases.push(db);return db}
afterEach(async()=>{for(const db of databases.splice(0))await db.delete()})
async function plan(db:PocketDatabase,title='单次计划',date='2026-11-14'){await initialize(db);return savePlan({title,date,body:'计划内容'},db)}

it('creates a canonical desktop task and preserves its status, properties and attachments during edits',async()=>{
 const db=database(),p=await plan(db,'  复习计划  ');expect(p).toMatchObject({type:'task',status:'todo',module_id:'module-plans',title:'复习计划',date:'2026-11-14'})
 await saveRecord({...p,properties:{custom_field:'保留'},attachments:[{file:'a'.repeat(32)+'.txt',name:'原始附件'}]},db);await setRecordCompletion(p.id,true,db);const old=(await db.records.get(p.id))!
 const updated=await savePlan({id:p.id,title:'修正名称',date:'2026-11-15',body:'补充正文'},db,old.updated_at);expect(updated.status).toBe('done');expect(updated.properties.custom_field).toBe('保留');expect(updated.attachments).toEqual(old.attachments);expect(updated.created_at).toBe(p.created_at)
})

it('accumulates multiple sessions across days, excludes pauses and short/deleted intervals, and never completes on end',async()=>{
 const db=database(),p=await plan(db),first=await startSession('record',p.id,100000,db);await pauseSession(first.id,140000,db);await resumeSession(first.id,200000,db);await endSession(first.id,260000,db);expect((await db.records.get(p.id))?.status).toBe('todo')
 const second=await startSession('record',p.id,86400000,db);await endSession(second.id,86460000,db);const short=await startSession('record',p.id,86500000,db);await endSession(short.id,86530000,db);const rows=await db.sessions.toArray();expect(planMilliseconds(rows,p.id)).toBe(160000);expect(planMilliseconds([...rows,rows[0]],p.id)).toBe(160000);expect(planMilliseconds([...rows,{...rows[0],id:'routine-collision',subjectKind:'routine'}],p.id)).toBe(160000);expect((await db.records.get(p.id))?.status).toBe('todo')
})

it('checking a running or paused plan closes only its current session and permits reopening for another interval',async()=>{
 const db=database(),p=await plan(db),s=await startSession('record',p.id,100000,db);await pauseSession(s.id,140000,db);expect(isSessionPaused((await db.sessions.get(s.id))!)).toBe(true)
 await setRecordCompletion(p.id,true,db,300000);expect((await db.records.get(p.id))?.status).toBe('done');expect((await db.sessions.get(s.id))?.endedAt).toBe(new Date(300000).toISOString());expect(await db.local.get('activeSession')).toBeUndefined();expect(planMilliseconds(await db.sessions.toArray(),p.id)).toBe(40000)
 await expect(startSession('record',p.id,400000,db)).rejects.toThrow('重新打开');await setRecordCompletion(p.id,false,db);const next=await startSession('record',p.id,400000,db);expect(next.id).not.toBe(s.id);expect((await db.records.get(p.id))?.status).toBe('todo')
})

it('supports completion without timing and leaves another active routine untouched',async()=>{
 const db=database(),p=await plan(db);await setRecordCompletion(p.id,true,db);expect(await db.sessions.count()).toBe(0);const s=await startSession('routine','daily-cooking',100000,db);await setRecordCompletion(p.id,false,db);await setRecordCompletion(p.id,true,db,200000);expect((await db.sessions.get(s.id))?.endedAt).toBeNull();expect((await db.local.get('activeSession'))?.value).toBe(s.id)
 const note=await saveRecord({...recordDraft('module-pocket-notes','2026-11-14','note'),title:'随手记'},db);await expect(setRecordCompletion(note.id,true,db)).rejects.toThrow('找不到计划');await expect(savePlan({id:note.id,title:'不能替换',date:note.date,body:''},db)).rejects.toThrow('找不到计划')
})

it('rolls back both completion and timer ending on persistence failure or a backward clock',async()=>{
 const db=database(),p=await plan(db),s=await startSession('record',p.id,100000,db),count=await db.operations.count();await expect(setRecordCompletion(p.id,true,db,90000)).rejects.toThrow('系统时间')
 const fail=(_key:unknown,op:{entity:string})=>{if(op.entity==='records')throw Error('disk full')};db.operations.hook('creating',fail);await expect(setRecordCompletion(p.id,true,db,200000)).rejects.toThrow('disk full');db.operations.hook('creating').unsubscribe(fail);expect((await db.sessions.get(s.id))?.endedAt).toBeNull();expect((await db.records.get(p.id))?.status).toBe('todo');expect((await db.local.get('activeSession'))?.value).toBe(s.id);expect(await db.operations.count()).toBe(count)
})

it('syncs repeated timing and explicit completion, and restores it from backup without transferring the active marker',async()=>{
 const a=database(),b=database(),remote=new MemoryDrive(),p=await plan(a);for(const start of [100000,300000]){const s=await startSession('record',p.id,start,a);await endSession(s.id,start+60000,a)}await sync(a,remote.transport());await sync(b,remote.transport());expect((await b.records.get(p.id))?.status).toBe('todo');expect(planMilliseconds(await b.sessions.toArray(),p.id)).toBe(120000)
 await setRecordCompletion(p.id,true,b);await sync(b,remote.transport());await sync(a,remote.transport());expect((await a.records.get(p.id))?.status).toBe('done');const restored=database();await restoreBackup(await exportBackup(a),restored);expect((await restored.records.get(p.id))?.status).toBe('done');expect(planMilliseconds(await restored.sessions.toArray(),p.id)).toBe(120000);expect(await restored.local.get('activeSession')).toBeUndefined()
})

it('carries pending plans forward, excludes future/deleted/archived items and does not duplicate plans each day',async()=>{
 const db=database(),old=await plan(db,'昨天未完成','2026-11-13'),future=await plan(db,'明天的计划','2026-11-15'),deleted=await plan(db,'已删除');await saveRecord({...deleted,deleted:true},db)
 const records=await db.records.toArray(),modules=await db.modules.toArray();expect(plansForDate(records,modules,'2026-11-14').map(r=>r.id)).toEqual([old.id]);expect(plansForDate(records,modules,'2026-11-15').map(r=>r.id)).toEqual([old.id,future.id]);expect(plansForDate(records,modules,'2026-11-14',true).map(r=>r.id)).toEqual([old.id,future.id]);expect(plansForDate(records,modules.map(m=>({...m,archived:true})),'2026-11-15')).toHaveLength(0);expect(await db.records.count()).toBe(3)
})
