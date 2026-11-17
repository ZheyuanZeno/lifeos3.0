import type {PocketDatabase} from './database'
import {type Entity,type LifeRecord,type Session,iso,validateRow} from './model'
import {digest,canonical} from './ai/protocol'
import {transaction,saveRecord,recordDraft,setRecordCompletion,saveRoutine,saveModule,saveHistoricalSession,setRecordDeleted,deleteSession,setCompletion,startSession,pauseSession,resumeSession,endSession} from './repository'
import {validateBusinessCommand,commandEntity,type BusinessCommand} from './native-business-contracts'
export interface BusinessPreview {command:BusinessCommand;hash:string;rows:{id:string;status:'new'|'update'|'skip'|'conflict';reason:string;action:any;before?:any}[]}
function target(c:BusinessCommand){const a=c.args;if(c.tool==='lifeos_set_routine_completion')return {entity:'completions' as Entity,id:a.routine_id+'_'+a.date};if(c.tool==='lifeos_control_timer'&&a.action==='start')return {entity:(a.subject_kind==='routine'?'routines':'records') as Entity,id:a.subject_id};return {entity:commandEntity(c.tool),id:a.id}}
export async function businessPreview(value:unknown,db:PocketDatabase):Promise<BusinessPreview>{
 const c=validateBusinessCommand(value),hash=await digest(c),previous=(await db.local.get('ai-result:'+c.command_id))?.value as any
 if(previous&&previous.hash!==hash)throw Error('同一命令编号的内容发生变化')
 const t=target(c),create=c.tool.startsWith('lifeos_create_'),source=c.args.data?.source_id
 let id=create?'ai_'+(await digest(['native',t.entity,source||c.command_id])).slice(0,48):t.id
 let before=id?await db.table(t.entity).get(id):undefined
 if(create&&source&&t.entity==='records')before=await db.records.filter(r=>r.source_id===source).first()??before
 if(before)id=before.id
 let status:BusinessPreview['rows'][number]['status']=create?'new':'update',reason=''
 if(previous){status='skip';reason='命令已应用'}else if(create&&before){status='skip';reason='稳定编号/来源已存在，不覆盖'}
 else if(!create&&c.tool!=='lifeos_set_routine_completion'&&!before){status='conflict';reason='目标不存在'}
 else if(!create&&(before?await digest(before)!==c.args.expected_version:!!c.args.expected_version)){status='conflict';reason='版本已变化，请重新查询后提交新命令'}
 if(c.tool==='lifeos_control_timer'&&c.args.action==='start')id='ai_'+(await digest(['timer',c.command_id])).slice(0,48)
 return {command:c,hash,rows:[{id,status,reason,before,action:{action:c.tool,data:c.args.data??c.args}}]}
}
export async function executeBusiness(p:BusinessPreview,db:PocketDatabase){
 const fresh=await businessPreview(p.command,db);if(canonical(fresh)!==canonical(p))throw Error('审核已过期，请重新检查')
 if(p.rows.some(r=>r.status==='conflict'))throw Error('存在版本冲突，未写入')
 return transaction(db,async()=>{
  const seen=await db.local.get('ai-result:'+p.command.command_id);if(seen){if((seen.value as any).hash!==p.hash)throw Error('命令编号冲突');return seen.value}
  const c=p.command,a=c.args,r=p.rows[0],t=target(c),now=iso();let output:any
  if(r.status!=='skip'){
   const current=t.id?await db.table(t.entity).get(t.id):await db.table(t.entity).get(r.id)
   if(canonical(current??null)!==canonical(r.before??null))throw Error('记录在审核后发生变化')
   const d=a.data??{}
   if(c.tool==='lifeos_control_timer'){
    const at=Date.parse(a.at??c.created_at)
    if(a.action==='start')output=await startSession(a.subject_kind,a.subject_id,at,db,r.id,'ai-import')
    else if(a.action==='pause')output=await pauseSession(a.id,at,db)
    else if(a.action==='resume')output=await resumeSession(a.id,at,db)
    else {await endSession(a.id,at,db);output=await db.sessions.get(a.id)}

   }else if(t.entity==='records'){
    if(c.tool==='lifeos_delete_record')output=await setRecordDeleted(a.id,true,db)
    else{
     const type=c.tool==='lifeos_create_idea'?'note':d.type??r.before?.type??'note'
     const module=d.module_id?await db.modules.get(d.module_id):r.before?await db.modules.get(r.before.module_id):await db.modules.where('kind').equals(type==='task'?'plans':'custom').filter(m=>!m.archived).first()
     if(!module||module.archived)throw Error('目标模块不存在或已归档')
     if(d.source_id&&await db.records.filter(v=>v.id!==r.id&&v.source_id===d.source_id).first())throw Error('来源已被其他记录使用')
     const row={...(r.before??recordDraft(module.id,d.date,type==='task'?'task':'note')),...d,id:r.id,module_id:module.id,type,created_at:r.before?.created_at??c.created_at,updated_at:now} as LifeRecord
     if(r.before?.type==='task'&&row.type!=='task'&&await db.sessions.filter(s=>!s.deleted&&!s.endedAt&&s.subjectKind==='record'&&s.subjectId===row.id).count())throw Error('请先结束此计划的计时再修改记录类型')
     validateRow('records',row)
     if(row.type==='task'&&r.before?.type==='task'&&row.status!==r.before.status)await setRecordCompletion(row.id,row.status==='done',db)
     if(row.deleted&&!r.before?.deleted&&r.before)await setRecordDeleted(row.id,true,db)
     output=await saveRecord(row,db)
    }
   }else if(t.entity==='routines'){
    if(c.tool==='lifeos_delete_routine'){for(const s of await db.sessions.filter(s=>!s.deleted&&!s.endedAt&&s.subjectKind==='routine'&&s.subjectId===r.id).toArray())await endSession(s.id,Date.parse(c.created_at),db);output=await saveRoutine({...r.before,archived:true,deleted:true},db)}
    else {if(d.archived||d.deleted)for(const s of await db.sessions.filter(s=>!s.deleted&&!s.endedAt&&s.subjectKind==='routine'&&s.subjectId===r.id).toArray())await endSession(s.id,Date.parse(c.created_at),db);output=await saveRoutine({...{title:'',icon:'',category:'日常',days:[0,1,2,3,4,5,6],minimumMinutes:null,targetMinutes:30,order:await db.routines.count(),archived:false},...r.before,...d,...(r.before?{id:r.id}:{})},db,r.before?undefined:r.id)}
   }else if(t.entity==='modules')output=await saveModule({...{view:'list',fields:[],archived:false,layout:null},...r.before,...d,id:r.id},db)
   else if(t.entity==='completions')output=await setCompletion(a.routine_id,a.date,a.completed,db)
   else if(c.tool==='lifeos_delete_history'){await deleteSession(a.id,db);output=await db.sessions.get(a.id)}
   else{
    const old=r.before as Session|undefined,subjectKind=d.subject_kind??old?.subjectKind,subjectId=d.subject_id??old?.subjectId
    const subject=subjectKind==='routine'?await db.routines.get(subjectId):await db.records.get(subjectId)
    if(!subject)throw Error('找不到计时项目')
    const row={...old,id:r.id,subjectKind,subjectId,title:d.title??old?.title??subject.title,startedAt:d.started_at??old?.startedAt,endedAt:d.ended_at??old?.endedAt,timeZone:d.time_zone??old?.timeZone,deviceId:old?.deviceId??'ai-import',created_at:old?.created_at??c.created_at,updated_at:now,note:d.note??old?.note??'',...(d.pauses!==undefined?{pauses:d.pauses}:{}),...(d.deleted!==undefined?{deleted:d.deleted}:{})} as Session
    if(d.pauses===undefined&&old?.pauses&&(d.started_at||d.ended_at)){const lo=Date.parse(row.startedAt),hi=Date.parse(row.endedAt!);row.pauses=old.pauses.flatMap(p=>{const a=Math.max(lo,Date.parse(p.startedAt)),b=Math.min(hi,Date.parse(p.endedAt!));return b>a?[{startedAt:new Date(a).toISOString(),endedAt:new Date(b).toISOString()}]:[]})}
    output=await saveHistoricalSession(row,db)
   }
  }
  const result={command_id:c.command_id,hash:p.hash,status:'applied',at:now,targets:[output?.id??r.id],error:''};await db.local.put({key:'ai-result:'+c.command_id,value:result});return result
 })
}
export async function businessSnapshot(db:PocketDatabase){
 const all=await db.transaction('r',[db.modules,db.records,db.routines,db.sessions,db.completions],async()=>{const result:any[]=[];for(const entity of ['modules','records','routines','sessions','completions'] as Entity[])for(const data of await db.table(entity).toArray())result.push({entity,id:data.id,data});return result})
 for(const row of all)row.version=await digest(row.data)
 all.sort((a,b)=>a.entity.localeCompare(b.entity)||a.id.localeCompare(b.id))
 return {generation:await digest(all),rows:all}
}
