import {beforeEach,afterEach,describe,it,expect} from 'vitest'
import {PocketDatabase} from '../lifeos/pocket/src/database'
import {initialize,saveRecord,applyOperations} from '../lifeos/pocket/src/repository'
import {businessPreview,executeBusiness,businessSnapshot} from '../lifeos/pocket/src/native-business'
import {digest} from '../lifeos/pocket/src/ai/protocol'
import type {BusinessTool} from '../lifeos/pocket/src/native-business-contracts'
let db:PocketDatabase
let seq=0
const command=(tool:BusinessTool,args:any,id='native-'+(++seq))=>({protocol:'lifeos-native-v2',command_id:id,created_at:'2026-11-17T10:00:00Z',tool,args:{command_id:id,...args}})
const run=async(c:any)=>(await executeBusiness(await businessPreview(c,db),db)) as any
beforeEach(async()=>{db=new PocketDatabase('native-business-'+crypto.randomUUID());await initialize(db)})
afterEach(async()=>{await db.delete()})
describe('complete native business writes',()=>{
 it('creates an idea through the record repository, replays once and blocks stale edits',async()=>{
  const c=command('lifeos_create_idea',{data:{title:'产品想法',date:'2026-11-17',body:'正文',source_id:'idea:1'}})
  const result=await run(c);await run(c);expect(await db.records.count()).toBe(1)
  let row=(await db.records.get(result.targets[0]))!;expect(row.type).toBe('note')
  const old=await digest(row);await run(command('lifeos_update_record',{id:row.id,expected_version:old,data:{title:'修改标题'}}))
  const stale=await businessPreview(command('lifeos_update_record',{id:row.id,expected_version:old,data:{body:'覆盖人工内容'}}),db);expect(stale.rows[0].status).toBe('conflict');await expect(executeBusiness(stale,db)).rejects.toThrow()
  row=(await db.records.get(row.id))!;expect(row.title).toBe('修改标题');expect(row.body).toBe('正文');expect(await db.operations.where('[entity+recordId]').equals(['records',row.id]).count()).toBeGreaterThan(1)
 })
 it('supports all record types and module fields with transaction rollback for invalid expense',async()=>{
  const created=await run(command('lifeos_create_module',{data:{name:'个人收支',kind:'shopping',fields:[{id:'tag',name:'标签',type:'text'}]}}));const module=created.targets[0]
  for(const type of ['journal','activity','expense','task','note'])await run(command('lifeos_create_record',{data:{module_id:module,type,title:type,date:'2026-11-17',body:'完整正文',...(type==='expense'?{amount:'12.50',currency:'SEK'}:{})}}))
  expect(await db.records.count()).toBe(5);const count=await db.operations.count()
  await expect(run(command('lifeos_create_record',{data:{module_id:module,type:'expense',title:'非法支出',date:'2026-11-17',amount:'10'}}))).rejects.toThrow('金额')
  expect(await db.records.count()).toBe(5);expect(await db.operations.count()).toBe(count)
 })
 it('adds and edits history, completes routines, and soft deletes without losing the original record',async()=>{
  const routine=await run(command('lifeos_create_routine',{data:{title:'练琴',targetMinutes:20}})),id=routine.targets[0]
  await run(command('lifeos_set_routine_completion',{routine_id:id,date:'2026-11-17',completed:true}))
  expect((await db.completions.get(id+'_2026-11-17'))!.completed).toBe(true)
  const history=await run(command('lifeos_create_history',{data:{subject_kind:'routine',subject_id:id,started_at:'2026-11-17T08:00:00Z',ended_at:'2026-11-17T09:00:00Z',time_zone:'Europe/Berlin',note:'补录练习'}})),row=(await db.sessions.get(history.targets[0]))!
  await run(command('lifeos_update_history',{id:row.id,expected_version:await digest(row),data:{note:'补充备注'}}))
  const changed=(await db.sessions.get(row.id))!;expect(changed.note).toBe('补充备注')
  await run(command('lifeos_delete_history',{id:row.id,expected_version:await digest(changed)}));expect((await db.sessions.get(row.id))!.deleted).toBe(true)
  expect(await db.sessions.count()).toBe(1)
 })
 it('controls independent timers through existing functions and rejects editing live timers as history',async()=>{
  const routines=await db.routines.toArray(),first=routines[0],second=routines[1]
  const a=await run(command('lifeos_control_timer',{action:'start',subject_kind:'routine',subject_id:first.id,expected_version:await digest(first),at:'2026-11-17T10:00:00Z'}))
  const b=await run(command('lifeos_control_timer',{action:'start',subject_kind:'routine',subject_id:second.id,expected_version:await digest(second),at:'2026-11-17T10:00:00Z'}))
  expect(await db.sessions.count()).toBe(2)
  let row=(await db.sessions.get(a.targets[0]))!
  await expect(run(command('lifeos_update_history',{id:row.id,expected_version:await digest(row),data:{note:'不能用历史编辑活动计时'}}))).rejects.toThrow('正在计时')
  await run(command('lifeos_control_timer',{action:'pause',id:row.id,expected_version:await digest(row),at:'2026-11-17T10:01:00Z'}));row=(await db.sessions.get(row.id))!
  await run(command('lifeos_control_timer',{action:'resume',id:row.id,expected_version:await digest(row),at:'2026-11-17T10:02:00Z'}));row=(await db.sessions.get(row.id))!
  await run(command('lifeos_control_timer',{action:'stop',id:row.id,expected_version:await digest(row),at:'2026-11-17T10:03:00Z'}));expect((await db.sessions.get(row.id))!.endedAt).toBeTruthy();expect((await db.sessions.get(b.targets[0]))!.endedAt).toBeNull()
 })
 it('uses deterministic creation IDs across two devices and converges through the causal log',async()=>{
  const other=new PocketDatabase('native-peer-'+crypto.randomUUID());await initialize(other)
  try{const c=command('lifeos_create_history',{data:{subject_kind:'routine',subject_id:'routine-study',started_at:'2026-11-17T08:00:00Z',ended_at:'2026-11-17T09:00:00Z',time_zone:'Europe/Berlin'}})
   const actual=(await db.routines.toArray())[0].id;c.args.data.subject_id=actual
   await run(c);await executeBusiness(await businessPreview(c,other),other)
   await applyOperations(await other.operations.toArray(),db);await applyOperations(await db.operations.toArray(),other)
   expect(await db.sessions.count()).toBe(1);expect(await other.sessions.count()).toBe(1);expect((await db.sessions.toArray())[0].id).toBe((await other.sessions.toArray())[0].id)
  }finally{await other.delete()}
 })
 it('snapshots all business entities but never local credentials, raw media or operation logs',async()=>{
  await db.local.put({key:'private-token',value:'DO-NOT-EXPORT'});await run(command('lifeos_create_idea',{data:{title:'想法',date:'2020-01-01',body:'很久以前'}}))
  const snapshot=await businessSnapshot(db);expect(snapshot.rows.some(r=>r.data.date==='2020-01-01')).toBe(true);expect(JSON.stringify(snapshot)).not.toContain('DO-NOT-EXPORT');expect(snapshot.rows.every(r=>['modules','records','routines','sessions','completions'].includes(r.entity))).toBe(true)
 })
})
