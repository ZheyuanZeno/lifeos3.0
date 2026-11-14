import {afterEach,expect,it} from 'vitest'
import {PocketDatabase} from '../lifeos/pocket/src/database'
import {initialize,startSession,endSession,pauseSession,saveRecord,setRecordCompletion,applyOperations,exportBackup,restoreBackup} from '../lifeos/pocket/src/repository'
import {saveFlow,handleFlow,advanceFlow} from '../lifeos/pocket/src/flow-repository'
import {flowOf,waitingStep,flowElapsed,parseFlow} from '../lifeos/pocket/src/background-flow'
import {openSessions} from '../lifeos/pocket/src/shared-timer'
import {planMilliseconds} from '../lifeos/pocket/src/time'
import {projectReminders,reminderSchedule,validateProjection} from '../lifeos/pocket/src/notifications/projection'
import {materialize} from '../lifeos/pocket/src/merge'
import {sync} from '../lifeos/pocket/src/sync/engine'
import {MemoryDrive} from './sync-memory'
const databases:PocketDatabase[]=[]
function database(){const db=new PocketDatabase('flow-'+crypto.randomUUID());databases.push(db);return db}
afterEach(async()=>{for(const db of databases.splice(0))await db.delete()})
async function create(db:PocketDatabase,title='洗衣服'){await initialize(db);return saveFlow({title,date:'2026-11-14',body:'private notes',steps:[{title:'洗涤',minutes:60},{title:'烘干',minutes:60}]},db)}
async function flow(db:PocketDatabase,id:string){return flowOf((await db.records.get(id))!)!}

it('laundry has three human intervals and two independent background stages without double counting',async()=>{
 const db=database(),p=await create(db);await handleFlow(p.id,100000,db);await advanceFlow(p.id,160000,db)
 expect(openSessions(await db.sessions.toArray())).toHaveLength(0);expect(waitingStep(await flow(db,p.id))?.title).toBe('洗涤')
 const studying=await startSession('routine','daily-studying',200000,db);await expect(handleFlow(p.id,3760000,db)).rejects.toThrow('先结束');await endSession(studying.id,3700000,db)
 await handleFlow(p.id,3760000,db);await advanceFlow(p.id,3820000,db);expect((await flow(db,p.id)).steps[0].handledAt).toBe(new Date(3760000).toISOString());expect(waitingStep(await flow(db,p.id))?.title).toBe('烘干')
 await handleFlow(p.id,7420000,db);await advanceFlow(p.id,7480000,db)
 expect((await db.records.get(p.id))?.status).toBe('done');expect(planMilliseconds(await db.sessions.toArray(),p.id)).toBe(180000);expect(flowElapsed(await flow(db,p.id),9000000)).toBe(7380000);expect(openSessions(await db.sessions.toArray())).toHaveLength(0)
})
it('multiple machines can wait concurrently while only one human activity runs, including paused locking',async()=>{
 const db=database(),a=await create(db),b=await create(db,'炖汤');await handleFlow(a.id,100000,db);await advanceFlow(a.id,140000,db);await handleFlow(b.id,150000,db);await advanceFlow(b.id,190000,db)
 expect([await flow(db,a.id),await flow(db,b.id)].every(f=>!!waitingStep(f))).toBe(true)
 const active=await startSession('routine','daily-studying',200000,db);await pauseSession(active.id,240000,db);await expect(handleFlow(a.id,250000,db)).rejects.toThrow('先结束')
 db.close();await db.open();expect(waitingStep(await flow(db,a.id))?.expectedEndAt).toBe(new Date(3740000).toISOString())
})
it('generic stop permits continuing preparation, short handling is discarded but physical stage is preserved',async()=>{
 const db=database(),p=await create(db),s=await handleFlow(p.id,100000,db);await endSession(s.id,120000,db);await expect(advanceFlow(p.id,130000,db)).rejects.toThrow('先开始')
 await handleFlow(p.id,140000,db);await advanceFlow(p.id,160000,db);expect(planMilliseconds(await db.sessions.toArray(),p.id)).toBe(0);expect(waitingStep(await flow(db,p.id))).toBeDefined();expect((await db.records.get(p.id))?.status).toBe('todo')
 await expect(startSession('record',p.id,180000,db)).rejects.toThrow('去处理')
})
it('stale actions, invalid stages and backward clocks fail without partial writes',async()=>{
 const db=database(),p=await create(db),snapshot=p.properties.background_flow;await handleFlow(p.id,100000,db)
 await expect(advanceFlow(p.id,140000,db,snapshot)).rejects.toThrow('流程已变化');const count=await db.operations.count()
 await expect(advanceFlow(p.id,90000,db)).rejects.toThrow('系统时间');expect(await db.operations.count()).toBe(count);expect(openSessions(await db.sessions.toArray())).toHaveLength(1)
 await expect(saveFlow({title:'坏流程',date:p.date,body:'',steps:[]},db)).rejects.toThrow();expect(await db.records.count()).toBe(1)
 const invalid=JSON.parse(snapshot);invalid.steps[1].startedAt=new Date(150000).toISOString();expect(()=>parseFlow(JSON.stringify(invalid))).toThrow()
})
it('edits retain active stages and history, explicit finish cancels reminders, reopening preserves the timeline',async()=>{
 const db=database(),p=await create(db);await handleFlow(p.id,100000,db);await advanceFlow(p.id,140000,db);const before=await flow(db,p.id)
 await saveFlow({id:p.id,title:'衣物',date:p.date,body:'updated private',steps:[]},db);expect(await flow(db,p.id)).toEqual(before)
 await setRecordCompletion(p.id,true,db,200000);expect(reminderSchedule(projectReminders(await db.operations.toArray()))).toEqual([]);await setRecordCompletion(p.id,false,db,210000);expect((await flow(db,p.id)).endedAt).toBeUndefined();expect((await flow(db,p.id)).steps).toEqual(before.steps)
})
it('manual Drive exchange and backup restore retain waiting, later handling and desktop-compatible task identity',async()=>{
 const a=database(),b=database(),restored=database(),remote=new MemoryDrive(),p=await create(a);await handleFlow(p.id,100000,a);await advanceFlow(p.id,140000,a);await sync(a,remote.transport());await sync(b,remote.transport())
 expect(await flow(b,p.id)).toEqual(await flow(a,p.id));await handleFlow(p.id,3740000,b);await advanceFlow(p.id,3800000,b);await sync(b,remote.transport());await sync(a,remote.transport());expect(await flow(a,p.id)).toEqual(await flow(b,p.id))
 await restoreBackup(await exportBackup(a),restored);expect(await flow(restored,p.id)).toEqual(await flow(a,p.id));expect((await restored.records.get(p.id))?.type).toBe('task');expect(planMilliseconds(await restored.sessions.toArray(),p.id)).toBe(100000)
})
it('concurrent stale property edits cannot rewind stages or re-arm the previous notification',async()=>{
 const a=database(),b=database(),p=await create(a);await handleFlow(p.id,100000,a);await advanceFlow(p.id,140000,a);await applyOperations(await a.operations.toArray(),b)
 await handleFlow(p.id,3740000,a);await advanceFlow(p.id,3800000,a)
 const stale=(await b.records.get(p.id))!;for(let i=0;i<8;i++)await saveRecord({...stale,properties:{...stale.properties,custom:String(i)}},b)
 const all=[...new Map([...await a.operations.toArray(),...await b.operations.toArray()].map(o=>[o.id,o])).values()];const ops=all.filter(o=>o.entity==='records'&&o.recordId===p.id)
 for(const history of [ops,[...ops].reverse()])expect(waitingStep(flowOf(materialize(history).row as never)!)?.title).toBe('烘干')
 const projected=projectReminders(all);validateProjection(projected);expect(JSON.stringify(projected)).not.toContain('private');expect(reminderSchedule(projected)).toMatchObject([{id:p.id,message:'烘干时间到了，请处理',at:7400000}])
 await applyOperations(all,b);expect(waitingStep(await flow(b,p.id))?.title).toBe('烘干')
})
it('phase notifications have separate stable keys and disappear on handle/delete',async()=>{
 const db=database(),p=await create(db);await handleFlow(p.id,100000,db);expect(reminderSchedule(projectReminders(await db.operations.toArray()))).toEqual([])
 await advanceFlow(p.id,140000,db);const first=reminderSchedule(projectReminders(await db.operations.toArray()))[0];await handleFlow(p.id,3740000,db);expect(reminderSchedule(projectReminders(await db.operations.toArray()))).toEqual([])
 await advanceFlow(p.id,3800000,db);const second=reminderSchedule(projectReminders(await db.operations.toArray()))[0];expect(second.key).not.toBe(first.key)
 await saveRecord({...((await db.records.get(p.id))!),deleted:true},db);expect(reminderSchedule(projectReminders(await db.operations.toArray()))).toEqual([])
})

it('a failed phase write rolls back the human timer, flow progress and operation sequence together',async()=>{
 const db=database(),p=await create(db),session=await handleFlow(p.id,100000,db),count=await db.operations.count()
 const fail=(_key:unknown,op:{entity:string})=>{if(op.entity==='records')throw Error('disk full')};db.operations.hook('creating',fail)
 await expect(advanceFlow(p.id,140000,db)).rejects.toThrow('disk full');db.operations.hook('creating').unsubscribe(fail)
 expect((await db.sessions.get(session.id))?.endedAt).toBeNull();expect(waitingStep(await flow(db,p.id))).toBeUndefined();expect(await db.operations.count()).toBe(count)
})
