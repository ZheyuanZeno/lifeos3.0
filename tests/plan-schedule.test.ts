import {afterEach,expect,it} from 'vitest'
import {PocketDatabase} from '../lifeos/pocket/src/database'
import {initialize,savePlan,exportBackup,restoreBackup} from '../lifeos/pocket/src/repository'
import {plannedTime,planSchedule} from '../lifeos/pocket/src/plans'
import {sync} from '../lifeos/pocket/src/sync/engine'
import {MemoryDrive} from './sync-memory'
const databases:PocketDatabase[]=[]
function database(){const db=new PocketDatabase('schedule-'+crypto.randomUUID());databases.push(db);return db}
afterEach(async()=>{for(const db of databases.splice(0))await db.delete()})
it('allows both attributes to be absent and stores minute precision in the recording timezone',async()=>{
 const db=database();await initialize(db);const empty=await savePlan({title:'无时间的计划',date:'2026-11-14',body:'',deadline:'',plannedTime:''},db);expect(empty.properties).toEqual({})
 const timed=await savePlan({title:'下午的计划',date:'2026-11-14',body:'',deadline:'2026-11-18',plannedTime:'14:35',timeZone:'Europe/Berlin'},db);expect(timed.properties).toMatchObject({plan_deadline:'2026-11-18',planned_start:'2026-11-14T13:35:00.000Z',time_zone:'Europe/Berlin'});expect(plannedTime(timed)).toBe('14:35');expect(timed.status).toBe('todo')
})
it('preserves unknown properties and schedules on unrelated edits, explicitly clears optional values and reschedules on date edits',()=>{
 const original={custom:'保留',plan_deadline:'2026-11-20',planned_start:'2026-11-14T13:35:00.000Z',time_zone:'Europe/Berlin'}
 expect(planSchedule(original,'2026-11-14',{})).toEqual(original);const cleared=planSchedule(original,'2026-11-14',{deadline:'',plannedTime:''});expect(cleared).toMatchObject({custom:'保留',plan_deadline:'',planned_start:'',time_zone:'Europe/Berlin'});expect(original.plan_deadline).toBe('2026-11-20')
 expect(planSchedule(original,'2026-11-15',{plannedTime:'14:35'}).planned_start).toBe('2026-11-15T13:35:00.000Z')
})
it('rejects invalid deadline or time without partially writing the record or operations',async()=>{
 const db=database();await initialize(db);const old=await savePlan({title:'原计划',date:'2026-11-14',body:''},db),count=await db.operations.count()
 for(const input of [{deadline:'2026-02-30'},{deadline:'2026/11/14'},{plannedTime:'24:00'},{plannedTime:'14:35:05'},{plannedTime:'12:00',timeZone:'invalid/zone'}])await expect(savePlan({...old,...input},db)).rejects.toThrow()
 expect(await db.records.get(old.id)).toEqual(old);expect(await db.operations.count()).toBe(count)
})
it('rejects a nonexistent daylight-saving minute and preserves an existing ambiguous instant',()=>{
 expect(()=>planSchedule({},'2026-03-29',{plannedTime:'02:30',timeZone:'Europe/Berlin'})).toThrow('不存在')
 const fold={planned_start:'2026-10-25T01:30:00.000Z',time_zone:'Europe/Berlin'};expect(planSchedule(fold,'2026-10-25',{plannedTime:'02:30'}).planned_start).toBe(fold.planned_start);expect(planSchedule({},'2026-10-25',{plannedTime:'02:30',timeZone:'Europe/Berlin'}).planned_start).toBe('2026-10-25T00:30:00.000Z')
})
it('roundtrips deadline and scheduled minute through Drive operations and backup, including clearing',async()=>{
 const a=database(),b=database(),restored=database(),remote=new MemoryDrive();await initialize(a);const row=await savePlan({title:'跨端时间计划',date:'2026-11-14',body:'',deadline:'2026-11-20',plannedTime:'09:05',timeZone:'Asia/Shanghai'},a);await sync(a,remote.transport());await sync(b,remote.transport());expect((await b.records.get(row.id))?.properties).toEqual(row.properties);await restoreBackup(await exportBackup(b),restored);expect(plannedTime((await restored.records.get(row.id))!)).toBe('09:05')
 await savePlan({...row,deadline:'',plannedTime:''},b);await sync(b,remote.transport());await sync(a,remote.transport());expect((await a.records.get(row.id))?.properties).toMatchObject({plan_deadline:'',planned_start:''})
})
