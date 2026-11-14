import {validateOperation,type Operation} from '../model'
import {materialize} from '../merge'

const fields=['type','title','status','deleted','module_id','properties']
const properties=['planned_start','time_zone','plan_deadline']
export const MAX_OPERATIONS=20000
export function canonical(value:unknown):string {return JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v)}
// Send only reminder metadata. Notes, media, sessions and unrelated records stay out.
export function projectReminders(operations:Operation[]):Operation[]{
 const tasks=new Set(operations.filter(o=>o.entity==='records'&&o.patch.type==='task').map(o=>o.recordId))
 return operations.filter(o=>o.entity==='modules'||o.entity==='records'&&tasks.has(o.recordId)).flatMap(o=>{
  const patch:Record<string,unknown>={}
  for(const key of o.entity==='modules'?['archived']:fields){
   if(!Object.hasOwn(o.patch,key))continue
   if(key==='properties')patch.properties=Object.fromEntries(Object.entries(o.patch.properties as Record<string,string>).filter(([k])=>properties.includes(k)))
   else patch[key]=o.patch[key]
  }
  if(!Object.keys(patch).length)return []
  return [{id:o.id,deviceId:o.deviceId,sequence:o.sequence,clock:o.clock,context:o.context,entity:o.entity,recordId:o.recordId,patch,timestamp:o.timestamp,uploaded:0,...(o.origin?{origin:o.origin}:{})}]
 }).sort((a,b)=>a.id.localeCompare(b.id))
}
export function validateProjection(value:unknown):asserts value is Operation[]{
 if(!Array.isArray(value)||value.length>MAX_OPERATIONS)throw Error('提醒操作超过限制')
 const ids=new Set<string>()
 for(const o of value){
  validateOperation(o)
  if(ids.has(o.id))throw Error('重复的提醒操作');ids.add(o.id)
  if(!['records','modules'].includes(o.entity))throw Error('提醒实体无效')
  for(const [k,v] of Object.entries(o.patch)){
   if(!(o.entity==='modules'?['archived']:fields).includes(k))throw Error('提醒字段无效')
   if(['deleted','archived'].includes(k)){if(typeof v!=='boolean')throw Error('提醒状态无效')}
   else if(k==='properties'){
    if(!v||typeof v!=='object'||Array.isArray(v)||Object.entries(v).some(([p,t])=>!properties.includes(p)||typeof t!=='string'||t.length>200))throw Error('提醒时间属性无效')
    const time=(v as Record<string,string>).planned_start
    if(time&&(!/(?:Z|[+-]\d{2}:\d{2})$/.test(time)||!Number.isFinite(Date.parse(time))))throw Error('提醒时间无效')
   }else if(typeof v!=='string'||v.length>(k==='title'?200:100))throw Error('提醒文字无效')
  }
 }
}
export interface Reminder {id:string;title:string;at:number;key:string}
export function reminderSchedule(operations:Operation[]):Reminder[]{
 const groups=new Map<string,Operation[]>()
 for(const o of operations){const key=o.entity+'/'+o.recordId;const group=groups.get(key)??[];group.push(o);groups.set(key,group)}
 const archived=new Set<string>(),records:Record<string,unknown>[]=[]
 for(const [key,group] of groups){const row=materialize(group).row;if(key.startsWith('modules/')){if(row.archived===true)archived.add(String(row.id))}else records.push(row)}
 return records.flatMap(r=>{
  const at=Date.parse(String((r.properties as Record<string,string>|undefined)?.planned_start??''))
  return r.type==='task'&&r.status==='todo'&&r.deleted!==true&&!archived.has(String(r.module_id))&&typeof r.title==='string'&&Number.isFinite(at)?[{id:String(r.id),title:r.title,at,key:String(r.id)+'_'+at}]:[]
 }).sort((a,b)=>a.at-b.at||a.id.localeCompare(b.id))
}
