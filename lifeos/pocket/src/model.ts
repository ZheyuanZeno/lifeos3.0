import {parseFlow} from './background-flow'
export type Entity = 'modules' | 'records' | 'routines' | 'completions' | 'sessions'
export const entities: Entity[] = ['modules', 'records', 'routines', 'completions', 'sessions']
export interface Module { id: string; name: string; kind: 'journal'|'health'|'shopping'|'plans'|'custom'; view: 'list'|'table'; fields: {id:string; name:string; type:string}[]; archived: boolean; layout: {x:number;y:number;width:number;height:number}|null }
export interface LifeRecord { id:string; module_id:string; type:'journal'|'activity'|'expense'|'task'|'note'; date:string; title:string; body:string; time_label:string; amount:string|null; currency:string; status:'todo'|'done'; source_id:string; attachments:{file:string;name:string}[]; properties:Record<string,string>; created_at:string; updated_at:string; deleted:boolean }
export interface Routine { id:string; title:string; icon:string; category:string; days:number[]; minimumMinutes:number|null; targetMinutes:number; order:number; archived:boolean; created_at:string; updated_at:string; deleted?:boolean }
export interface Completion { id:string; routineId:string; date:string; completed:boolean; created_at:string; updated_at:string; deleted?:boolean }
export interface SessionPause {startedAt:string;endedAt:string|null}
export interface Session { id:string; subjectId:string; subjectKind:'routine'|'record'; title:string; startedAt:string; endedAt:string|null; timeZone:string; deviceId:string; created_at:string; updated_at:string; deleted?:boolean; pauses?:SessionPause[]; note?:string }
export interface Rows { modules:Module; records:LifeRecord; routines:Routine; completions:Completion; sessions:Session }
export interface Operation { origin?:'seed'; id:string; deviceId:string; sequence:number; clock:number; context:Record<string,number>; entity:Entity; recordId:string; patch:Record<string,unknown>; timestamp:string; uploaded:number }
export interface LocalState { key:string; value:unknown }
export interface Identity { id:string; sequence:number; clock:number }
export const uuid = () => crypto.randomUUID().replaceAll('-', '')
export const iso = () => new Date().toISOString()
export const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone
const safeId = /^[a-zA-Z0-9_-]{1,100}$/
export function validDate(value:unknown): value is string { if(typeof value !== 'string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;try{return new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value}catch{return false} }
function instant(value:unknown):value is string { return typeof value==='string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) }
function text(value:unknown,max=100000) { return typeof value==='string'&&value.length<=max }
export function validateRow(entity:Entity, value:unknown):void {
  const r=value as Record<string,unknown>
  if(!r || typeof r!=='object'||typeof r.id!=='string'||!safeId.test(r.id))throw Error('记录编号无效')
  if(entity==='modules') {
    if(!text(r.name,80)||!(r.name as string).trim()||!['journal','health','shopping','plans','custom'].includes(String(r.kind))||!['list','table'].includes(String(r.view))||typeof r.archived!=='boolean'||!Array.isArray(r.fields)||r.fields.length>30)throw Error('模块格式无效')
    for(const f of r.fields)if(!f||!safeId.test(f.id)||!text(f.name,60)||!['text','number','date'].includes(f.type))throw Error('模块属性格式无效')
    return
  }
  if(!instant(r.created_at)||!instant(r.updated_at))throw Error('保存时间无效')
  if(r.deleted!==undefined&&typeof r.deleted!=='boolean')throw Error('删除状态无效')
  if(entity==='records') {
    if(!text(r.title,200)||!(r.title as string).trim()||!text(r.body)||!validDate(r.date)||!['journal','activity','expense','task','note'].includes(String(r.type))||!['todo','done'].includes(String(r.status))||!safeId.test(String(r.module_id))||typeof r.deleted!=='boolean'||!r.properties||typeof r.properties!=='object'||Array.isArray(r.properties)||!Array.isArray(r.attachments)||r.attachments.length>30)throw Error('记录格式无效')
    if(Object.entries(r.properties).some(([k,v])=>!safeId.test(k)||!text(v,10000)))throw Error('自定义属性格式无效')
    for(const k of ['time_label','currency','source_id'])if(!text(r[k]))throw Error('记录文字无效')
    if(r.amount!==null&&(typeof r.amount!=='string'||!/^\d{1,12}(?:\.\d{1,2})?$/.test(r.amount)))throw Error('金额格式无效')
    if(r.type==='expense'&&r.amount!==null&&!(r.currency as string).trim())throw Error('填写金额时也请填写币种')
    if((r.attachments as unknown[]).some(a=>!a||typeof a!=='object'||!text((a as {name:unknown}).name,300)||!/^[a-f0-9]{32}\.(?:png|jpg|jpeg|webp|gif|pdf|txt|m4a|mp4|webm|ogg|wav)$/.test(String((a as {file:unknown}).file))))throw Error('附件索引无效')
    for(const k of ['planned_start','planned_end'])if((r.properties as Record<string,string>)[k]&&!instant((r.properties as Record<string,string>)[k]))throw Error('计划时间无效')
    const props=r.properties as Record<string,string>
    if(props.background_flow!==undefined){if(r.type!=='task')throw Error('后台流程必须是计划');parseFlow(props.background_flow)}
    if(props.plan_deadline&&!validDate(props.plan_deadline))throw Error('DDL 日期无效')
    if(props.planned_start&&props.planned_end&&Date.parse(props.planned_end)<=Date.parse(props.planned_start))throw Error('结束时间必须晚于开始时间')
  } else if(entity==='routines') {
    if(!text(r.title,200)||!(r.title as string).trim()||!text(r.icon,12)||!text(r.category,80)||typeof r.archived!=='boolean'||!Number.isFinite(r.order)||!Array.isArray(r.days)||!r.days.length||r.days.length>7||r.days.some(d=>!Number.isInteger(d)||d<0||d>6)||typeof r.targetMinutes!=='number'||r.targetMinutes<1||r.targetMinutes>1440||(r.minimumMinutes!==null&&(typeof r.minimumMinutes!=='number'||r.minimumMinutes<0||r.minimumMinutes>r.targetMinutes)))throw Error('例行事项、重复日期或目标时长无效')
  } else if(entity==='completions') {
    if(!validDate(r.date)||!safeId.test(String(r.routineId))||r.id!==r.routineId+'_'+r.date||typeof r.completed!=='boolean')throw Error('完成记录格式无效')
  } else if(entity==='sessions') {
    if(r.note!==undefined&&!text(r.note,10000))throw Error('计时备注无效或超过 10000 字')
    if(!safeId.test(String(r.subjectId))||!['routine','record'].includes(String(r.subjectKind))||!text(r.title,200)||!instant(r.startedAt)||(r.endedAt!==null&&(!instant(r.endedAt)||Date.parse(r.endedAt)<Date.parse(String(r.startedAt))))||!safeId.test(String(r.deviceId)))throw Error('计时会话格式无效')
    try{new Intl.DateTimeFormat('en',{timeZone:String(r.timeZone)})}catch{throw Error('时区无效')}
    if(r.pauses!==undefined){
      if(!Array.isArray(r.pauses)||r.pauses.length>1000)throw Error('暂停记录无效')
      let last=Date.parse(String(r.startedAt))
      for(const [index,pause] of r.pauses.entries()){
        if(!pause||!instant(pause.startedAt)||Date.parse(pause.startedAt)<last||(pause.endedAt===null?(index!==r.pauses.length-1||r.endedAt!==null):(!instant(pause.endedAt)||Date.parse(pause.endedAt)<Date.parse(pause.startedAt)||(r.endedAt!==null&&Date.parse(pause.endedAt)>Date.parse(String(r.endedAt))))))throw Error('暂停时间顺序无效')
        last=pause.endedAt===null?Infinity:Date.parse(pause.endedAt)
      }
    }
  }
}
export function validateOperation(value:unknown):asserts value is Operation {
  const o=value as Operation
  if(!o||!safeId.test(o.id)||!safeId.test(o.deviceId)||!safeId.test(o.recordId)||!entities.includes(o.entity)||!Number.isSafeInteger(o.sequence)||o.sequence<1||!Number.isSafeInteger(o.clock)||o.clock<1||!o.context||typeof o.context!=='object'||Array.isArray(o.context)||Object.entries(o.context).some(([k,v])=>!safeId.test(k)||!Number.isSafeInteger(v)||v<0)||!o.patch||typeof o.patch!=='object'||Array.isArray(o.patch)||!instant(o.timestamp)||Object.keys(o.patch).some(k=>['__proto__','prototype','constructor','id'].includes(k)))throw Error('同步操作格式无效')
  if(o.origin!==undefined&&o.origin!=='seed')throw Error('同步操作来源无效')
  if((o.context[o.deviceId]??0)>=o.sequence)throw Error('操作因果顺序无效')
}
