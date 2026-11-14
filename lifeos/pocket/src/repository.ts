import { db as defaultDB, type PocketDatabase } from './database'
import { entities,iso,uuid,zone,validateRow,validateOperation, type Entity,type Rows,type Identity,type Operation,type Routine,type LifeRecord } from './model'
import { materialize } from './merge'
import { dailyPresets } from './defaults'
import { serializeMedia,deserializeMedia,importMedia,type MediaAsset } from './media'
import { MIN_SESSION_MS,isSessionPaused,sessionElapsed } from './time'
import {openSessions} from './shared-timer'
import {planSchedule,type PlanScheduleInput} from './plans'
import {flowOf,waitingStep} from './background-flow'

async function identity(database:PocketDatabase):Promise<Identity>{const saved=await database.local.get('identity');if(saved)return saved.value as Identity;const value={id:uuid(),sequence:0,clock:0};await database.local.put({key:'identity',value});return value}
// Caller must hold the same read-write transaction as the business write.
export async function putRow<E extends Entity>(entity:E,row:Rows[E],database:PocketDatabase=defaultDB,origin?:'seed'){
  validateRow(entity,row)
  const table=database.table<Rows[E],string>(entity), old=await table.get(row.id)
  const history=await database.operations.where('[entity+recordId]').equals([entity,row.id]).count()
  const patch:Record<string,unknown>={}
  for(const [key,value] of Object.entries(row))if(key!=='id'&&(!old||!history||JSON.stringify(value)!==JSON.stringify((old as unknown as Record<string,unknown>)[key])))patch[key]=value
  if(!Object.keys(patch).length)return row
  if(entity==='sessions'&&['startedAt','endedAt','pauses'].some(k=>k in patch)){
    const session=row as Rows['sessions'];patch.startedAt=session.startedAt;patch.endedAt=session.endedAt;if(session.pauses!==undefined)patch.pauses=session.pauses
  }
  const owner=await identity(database), all=await database.operations.toArray(),context:Record<string,number>={}
  for(const op of all){context[op.deviceId]=Math.max(context[op.deviceId]??0,op.sequence);owner.clock=Math.max(owner.clock,op.clock)}
  owner.sequence++;owner.clock++
  const operation:Operation={id:uuid(),deviceId:owner.id,sequence:owner.sequence,clock:owner.clock,context,entity,recordId:row.id,patch,timestamp:iso(),uploaded:0,...(origin?{origin}:{})}
  await table.put(row);await database.operations.add(operation);await database.local.put({key:'identity',value:owner})
  return row
}
export function transaction<T>(database:PocketDatabase,fn:()=>Promise<T>){return database.transaction('rw',database.tables,fn)}
export async function saveRoutine(input:Omit<Routine,'id'|'created_at'|'updated_at'> & {id?:string},database=defaultDB){return transaction(database,async()=>{const old=input.id?await database.routines.get(input.id):undefined;const now=iso();return putRow('routines',{...input,id:old?.id??uuid(),created_at:old?.created_at??now,updated_at:now},database)})}
export async function reorderRoutines(ids:string[],database=defaultDB){return transaction(database,async()=>{
  const all=(await database.routines.toArray()).filter(r=>!r.archived&&!r.deleted).sort((a,b)=>a.order-b.order||(a.id<b.id?-1:a.id>b.id?1:0)),selected=new Set(ids)
  if(selected.size!==ids.length||ids.some(id=>!all.some(r=>r.id===id)))throw Error('日程项目已变化，请重试排序')
  const byId=new Map(all.map(r=>[r.id,r])),queue=[...ids],ordered=all.map(r=>selected.has(r.id)?byId.get(queue.shift()!)!:r)
  if(ordered.every((r,i)=>r.id===all[i].id))return
  for(const [order,row] of ordered.entries())if(row.order!==order)await putRow('routines',{...row,order,updated_at:iso()},database)
})}
export async function setCompletion(routineId:string,date:string,completed:boolean,database=defaultDB){return transaction(database,async()=>{if(!await database.routines.get(routineId))throw Error('找不到例行事项');const id=routineId+'_'+date,old=await database.completions.get(id),now=iso();return putRow('completions',{id,routineId,date,completed,created_at:old?.created_at??now,updated_at:now},database)})}
export async function saveRecord(record:LifeRecord,database=defaultDB,expected?:string){return transaction(database,async()=>{const old=await database.records.get(record.id);if(expected&&old?.updated_at!==expected)throw Error('记录已在其他窗口更新，请重新打开');if(!await database.modules.get(record.module_id))throw Error('所属模块不存在');return putRow('records',{...record,created_at:old?.created_at??record.created_at,updated_at:iso()},database)})}
export async function saveAudioRecord(record:LifeRecord,asset:MediaAsset,database=defaultDB){return transaction(database,async()=>{await importMedia(asset,database);return saveRecord({...record,attachments:[...record.attachments,{file:asset.file,name:'语音记录.'+asset.file.split('.').at(-1)}]},database)})}
export async function savePlan(input:Pick<LifeRecord,'title'|'date'|'body'> & {id?:string} & PlanScheduleInput,database=defaultDB,expected?:string){return transaction(database,async()=>{
  const old=input.id?await database.records.get(input.id):undefined
  if(input.id&&(!old||old.deleted||old.type!=='task'))throw Error('找不到计划')
  const module=old?undefined:await database.modules.where('kind').equals('plans').filter(m=>!m.archived).first()
  if(!old&&!module)throw Error('计划模块暂不可用，请先与白板交换')
  const record=old??recordDraft(module!.id,input.date)
  return saveRecord({...record,title:input.title.trim(),date:input.date,body:input.body,properties:planSchedule(record.properties,input.date,input)},database,expected)
})}
export async function setRecordCompletion(id:string,done:boolean,database=defaultDB,at=Date.now()){return transaction(database,async()=>{
  const row=await database.records.get(id);if(!row||row.deleted||row.type!=='task')throw Error('找不到计划')
  if(done)for(const active of openSessions(await database.sessions.toArray()).filter(s=>s.subjectKind==='record'&&s.subjectId===id))await closeSession(active.id,at,database)
  if(row.status===(done?'done':'todo'))return row
  const flow=flowOf(row)
  if(flow){if(done){flow.startedAt??=new Date(at).toISOString();flow.endedAt=new Date(at).toISOString()}else delete flow.endedAt}
  return putRow('records',{...row,status:done?'done':'todo',properties:{...row.properties,...(flow?{background_flow:JSON.stringify(flow)}:{})},updated_at:iso()},database)
})}
export function recordDraft(moduleId:string,date:string,type:'task'|'note'='task'):LifeRecord{const now=iso();return {id:uuid(),module_id:moduleId,type,date,title:'',body:'',time_label:'',amount:null,currency:'',status:type==='task'?'todo':'done',source_id:'',attachments:[],properties:{},created_at:now,updated_at:now,deleted:false}}
export async function initialize(database=defaultDB){await transaction(database,async()=>{
  await identity(database)
  const modules=await database.modules.toArray()
  for(const m of [{id:'module-plans',name:'计划',kind:'plans' as const},{id:'module-pocket-notes',name:'随手记',kind:'custom' as const}])if(!modules.some(existing=>existing.kind===m.kind&&!existing.archived)){const id=modules.some(existing=>existing.id===m.id)?m.id+'_'+uuid():m.id;await putRow('modules',{...m,id,view:'list',fields:[],archived:false,layout:null},database,'seed')}
  if(!await database.local.get('dailyPresetsV1')){
    const now=iso()
    for(const [order,preset] of dailyPresets.entries())if(!await database.routines.get(preset.id))await putRow('routines',{...preset,order,category:'日常',days:[0,1,2,3,4,5,6],targetMinutes:30,minimumMinutes:null,archived:false,created_at:now,updated_at:now},database,'seed')
    await database.local.put({key:'dailyPresetsV1',value:true})
  }
})}
export async function startSession(subjectKind:'routine'|'record',subjectId:string,at=Date.now(),database=defaultDB){return transaction(database,async()=>{
  const subject=subjectKind==='routine'?await database.routines.get(subjectId):await database.records.get(subjectId)
  if(!subject||('archived' in subject&&subject.archived)||('deleted' in subject&&subject.deleted))throw Error('找不到可计时事项')
  if(subjectKind==='record'&&('type' in subject&&(subject.type!=='task'||subject.status==='done')))throw Error('请先重新打开已完成的计划')
  if(subjectKind==='record'&&waitingStep(flowOf(subject as LifeRecord)??{version:1,id:'none',steps:[]}))throw Error('请从后台流程选择去处理')
  const active=openSessions(await database.sessions.toArray())
  if(active.length){const matching=active.find(s=>s.subjectId===subjectId&&s.subjectKind===subjectKind);if(matching)return matching;throw Error('请先结束当前任务')}
  const now=new Date(at).toISOString(),owner=await identity(database)
  const row={id:uuid(),subjectId,subjectKind,title:subject.title,startedAt:now,endedAt:null,timeZone:zone(),deviceId:owner.id,created_at:now,updated_at:now}
  await putRow('sessions',row,database);await database.local.put({key:'activeSession',value:row.id});return row
})}
async function closeSession(id:string,at:number,database:PocketDatabase){
  const row=await database.sessions.get(id);if(!row||row.endedAt)return
  if(at<Date.parse(row.startedAt))throw Error('系统时间早于开始时间，请先校正时间；原会话仍保留')
  const last=row.pauses?.at(-1),boundary=last?.endedAt??last?.startedAt??row.startedAt
  if(at<Date.parse(boundary))throw Error('系统时间早于上次操作，请先校正时间')
  const endedAt=new Date(at).toISOString(),pauses=row.pauses?.map(p=>p.endedAt===null?{...p,endedAt}:p),next={...row,endedAt,updated_at:iso(),...(pauses?{pauses}:{})}
  await putRow('sessions',{...next,...(sessionElapsed(next)<=MIN_SESSION_MS?{deleted:true}:{})},database)
  if((await database.local.get('activeSession'))?.value===id)await database.local.delete('activeSession')
}
export async function endSession(id:string,at=Date.now(),database=defaultDB){return transaction(database,()=>closeSession(id,at,database))}
export async function pauseSession(id:string,at=Date.now(),database=defaultDB){return transaction(database,async()=>{
  const row=await database.sessions.get(id);if(!row||row.deleted||row.endedAt)throw Error('计时已结束')
  if(isSessionPaused(row))return row
  if(at<Date.parse(row.pauses?.at(-1)?.endedAt??row.startedAt))throw Error('系统时间早于上次操作，请先校正时间')
  return putRow('sessions',{...row,pauses:[...(row.pauses??[]),{startedAt:new Date(at).toISOString(),endedAt:null}],updated_at:iso()},database)
})}
export async function resumeSession(id:string,at=Date.now(),database=defaultDB){return transaction(database,async()=>{
  const row=await database.sessions.get(id);if(!row||row.deleted||row.endedAt)throw Error('计时已结束')
  if(!isSessionPaused(row))return row
  const last=row.pauses!.at(-1)!;if(at<Date.parse(last.startedAt))throw Error('系统时间早于暂停时间，请先校正时间')
  return putRow('sessions',{...row,pauses:row.pauses!.map((p,index)=>index===row.pauses!.length-1?{...p,endedAt:new Date(at).toISOString()}:p),updated_at:iso()},database)
})}
export async function editSession(id:string,startedAt:string,endedAt:string,database=defaultDB,note?:string){return transaction(database,async()=>{
  const old=await database.sessions.get(id);if(!old||old.deleted||!old.endedAt)throw Error('找不到可编辑的计时记录')
  const lo=Date.parse(startedAt),hi=Date.parse(endedAt),pauses=old.pauses?.flatMap(p=>{const start=Math.max(lo,Date.parse(p.startedAt)),end=Math.min(hi,Date.parse(p.endedAt!));return end>start?[{startedAt:new Date(start).toISOString(),endedAt:new Date(end).toISOString()}]:[]}),next={...old,startedAt,endedAt,updated_at:iso(),...(pauses?{pauses}:{})}
  return putRow('sessions',{...next,...(note!==undefined?{note}:{}),...(sessionElapsed(next)<=MIN_SESSION_MS?{deleted:true}:{})},database)
})}
export async function saveSessionNote(id:string,note:string,database=defaultDB,expectedNote?:string){return transaction(database,async()=>{
  const row=await database.sessions.get(id);if(!row||row.deleted)throw Error('找不到计时记录')
  if(expectedNote!==undefined&&(row.note??'')!==expectedNote)throw Error('备注已在其他窗口更新，请重新打开')
  return putRow('sessions',{...row,note,updated_at:iso()},database)
})}
export async function deleteSession(id:string,database=defaultDB){return transaction(database,async()=>{
  const row=await database.sessions.get(id);if(!row||row.deleted)return
  if(!row.endedAt)throw Error('请先停止计时')
  await putRow('sessions',{...row,deleted:true,updated_at:iso()},database)
  if((await database.local.get('activeSession'))?.value===id)await database.local.delete('activeSession')
})}
export async function applyOperations(incoming:unknown[],database=defaultDB,acknowledged=true){
  incoming.forEach(validateOperation)
  return transaction(database,async()=>{
    const changed=new Map<string,{entity:Entity;id:string}>()
    for(const op of incoming as Operation[]){
      const existing=await database.operations.get(op.id)
      if(existing){if(JSON.stringify(sort({...existing,uploaded:0}))!==JSON.stringify(sort({...op,uploaded:0})))throw Error('同步操作编号冲突');continue}
      await database.operations.add({...op,uploaded:acknowledged?1:0});changed.set(op.entity+'/'+op.recordId,{entity:op.entity,id:op.recordId})
    }
    for(const {entity,id} of changed.values()){
      const ops=await database.operations.where('[entity+recordId]').equals([entity,id]).toArray()
      const {row}=materialize(ops);validateRow(entity,row);await database.table(entity).put(row)
    }
    // References may arrive before their modules in another batch; hide them until dependencies arrive.
  })
}
export async function exportBackup(database=defaultDB):Promise<Record<string,unknown>>{const {payload,assets}=await database.transaction('r',database.tables,async()=>{
  const payload:Record<string,unknown>={format:'lifeos-pocket',schemaVersion:1,exportedAt:iso(),operations:await database.operations.toArray()}
  for(const entity of entities)payload[entity]=await database.table(entity).toArray()
  return {payload,assets:await database.media.toArray()}
});return {...payload,media:await Promise.all(assets.map(serializeMedia))}}
export async function restoreBackup(value:unknown,database=defaultDB){
  const backup=value as Record<string,unknown>
  if(!backup||backup.format!=='lifeos-pocket'||backup.schemaVersion!==1||!Array.isArray(backup.operations))throw Error('备份格式或版本不受支持')
  const groups=entities.map(entity=>{if(!Array.isArray(backup[entity]))throw Error('备份缺少 '+entity);const rows=backup[entity] as unknown[];rows.forEach(row=>validateRow(entity,row));return {entity,rows}})
  const ops=backup.operations as Operation[];ops.forEach(validateOperation)
  if(backup.media!==undefined&&(!Array.isArray(backup.media)||backup.media.length>1000))throw Error('备份录音列表无效')
  const assets=await Promise.all(((backup.media??[]) as unknown[]).map(deserializeMedia))
  // Never trust rows that disagree with their operation history. Validate everything before writes.
  for(const {entity,rows} of groups)for(const row of rows){const r=row as {id:string};const history=ops.filter(o=>o.entity===entity&&o.recordId===r.id);if(!history.length||[materialize(history).row,materialize(history,true).row].every(resolved=>JSON.stringify(sort(resolved))!==JSON.stringify(sort(row))))throw Error('备份记录与历史不一致')}
  await transaction(database,async()=>{for(const asset of assets)await importMedia(asset,database);await applyOperations(ops,database,false)})
}
function sort(value:unknown):unknown{if(Array.isArray(value))return value.map(sort);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,sort(v)]));return value}
export async function getIdentity(database=defaultDB){return transaction(database,()=>identity(database))}
