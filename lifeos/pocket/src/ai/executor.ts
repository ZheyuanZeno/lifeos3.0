import type {PocketDatabase} from '../database'
import {transaction,savePlan,saveRecord,recordDraft,setRecordCompletion} from '../repository'
import type {LifeRecord} from '../model'
import {validateCommand,actions,digest,canonical,type Command,type Action} from './protocol'
export interface Preview {command:Command;hash:string;allowSimilar:boolean;rows:{action:Action;id:string;status:'new'|'update'|'skip'|'conflict';reason:string;before?:LifeRecord}[]}
export const recordVersion=(row:LifeRecord)=>digest(row)
function similar(row:LifeRecord,a:Action){const norm=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');const x=norm(row.title),y=norm(a.data.title??'');return Math.abs(Date.parse(row.properties.plan_deadline||row.date)-Date.parse(a.data.deadline||a.data.date))<=2*86400000&&(x===y||Math.min(x.length,y.length)>=4&&(x.includes(y)||y.includes(x)))}
export async function preview(command:Command,db:PocketDatabase,allowSimilar=false):Promise<Preview>{
 const c=validateCommand(command),hash=await digest(c),seen=(await db.local.get('ai-result:'+c.command_id))?.value as {hash:string}|undefined
 if(seen&&seen.hash!==hash)throw Error('同一 command_id 的内容发生变化，已拒绝')
 const records=await db.records.toArray(),rows:Preview['rows']=[]
 for(const [index,a] of actions(c).entries()){
  const create=a.action.startsWith('create_'),id=create?'ai_'+(await digest([a.action.endsWith('note')?'note':'plan',a.data.source_id||c.command_id+':'+index])).slice(0,48):a.target_id!
  const before=records.find(r=>r.id===id)||(create&&a.data.source_id?records.find(r=>r.source_id===a.data.source_id):undefined)
  let status:Preview['rows'][number]['status']=create?'new':'update',reason=''
  if(seen){status='skip';reason='此命令已处理'}
  else if(create&&before){status='skip';reason='来源或稳定编号已存在（包括已删除记录），不覆盖'}
  else if(!create&&(!before||before.deleted||before.type!==(a.action.endsWith('note')?'note':'task'))){status='conflict';reason='目标不存在或类型不符'}
  else if(!create&&await recordVersion(before!)!==a.expected_version){status='conflict';reason='记录已在快照后修改，请生成新快照和新命令'}
  else if(a.data.source_id&&records.some(r=>r.id!==id&&r.source_id===a.data.source_id)){status='conflict';reason='来源编号已被其他记录使用'}
  else if(create&&!allowSimilar&&records.some(r=>!r.deleted&&similar(r,a))){status='conflict';reason='名称及日期接近但来源不同，可能重复，请人工处理'}
  if(rows.some(r=>r.id===(before?.id??id))){status='conflict';reason='同一批中多次操作同一目标，请拆分命令'}
  if(status==='new'&&a.action==='create_plan'&&!a.data.planned_start)reason='未安排具体开始时间，不会生成定时提醒'
  rows.push({action:a,id:before?.id??id,status,reason,before})
 }
 return {command:c,hash,rows,allowSimilar}
}
export async function execute(p:Preview,db:PocketDatabase){
 // Hash and review outside the IndexedDB transaction; recheck every row atomically inside it.
 const fresh=await preview(p.command,db,p.allowSimilar);if(canonical(fresh)!==canonical(p))throw Error('预览已过期，请重新检查')
 if(p.rows.some(r=>r.status==='conflict'))throw Error('命令存在冲突，整批未写入')
 try{return await transaction(db,async()=>{
  const previous=await db.local.get('ai-result:'+p.command.command_id);if(previous){if((previous.value as {hash:string}).hash!==p.hash)throw Error('命令 ID 内容冲突');return previous.value}
  const targets:string[]=[]
  for(const r of p.rows){
   if(r.status==='skip')continue
   const current=await db.records.get(r.id)
   if(canonical(current??null)!==canonical(r.before??null))throw Error('记录在审核后发生变化')
   const a=r.action,d=a.data,isPlan=a.action.endsWith('plan');let row=current
   if(d.source_id&&await db.records.filter(other=>other.id!==r.id&&other.source_id===d.source_id).first())throw Error('来源在审核后被其他记录占用，请重新检查')
   if(a.action==='complete_plan'){await setRecordCompletion(r.id,true,db);targets.push(r.id);continue}
   if(!row){
    const module=d.module_id?await db.modules.get(d.module_id):await db.modules.where('kind').equals(isPlan?'plans':'custom').filter(m=>!m.archived).first()
    if(!module||module.archived)throw Error('找不到可用的目标模块')
    row={...recordDraft(module.id,d.date,isPlan?'task':'note'),id:r.id,created_at:p.command.created_at}
    if(isPlan){await savePlan({title:d.title,date:d.date,body:d.body??'',createId:r.id},db);row={...row,type:'task'}}
   }
   const properties:Record<string,string>={...row.properties,ai_provider:p.command.source.provider,ai_command:p.command.command_id}
   if(d.deadline!==undefined)properties.plan_deadline=d.deadline
   if(d.planned_start!==undefined)properties.planned_start=d.planned_start?new Date(d.planned_start).toISOString():''
   if(d.time_zone!==undefined)properties.time_zone=d.time_zone
   await saveRecord({...row,title:d.title??row.title,date:d.date??row.date,body:d.body??row.body,source_id:d.source_id??row.source_id,properties},db)
   targets.push(r.id)
  }
  const result={command_id:p.command.command_id,hash:p.hash,status:'applied',at:new Date().toISOString(),targets,error:''};await db.local.put({key:'ai-result:'+p.command.command_id,value:result});return result
 })}catch(e){await db.local.put({key:'ai-error:'+p.command.command_id,value:{command_id:p.command.command_id,hash:p.hash,status:'failed',at:new Date().toISOString(),targets:p.rows.map(r=>r.id),error:String(e)}});throw e}
}
