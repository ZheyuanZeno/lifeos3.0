import type {PocketDatabase} from '../database'
import {validDate} from '../model'
import {recordVersion} from './executor'
import {sessionMilliseconds} from '../time'
export interface Selection {from:string;to:string;notes:boolean;body:boolean;stats:boolean;module?:string;status:'all'|'todo'|'done'}
export async function snapshot(db:PocketDatabase,s:Selection,syncStatus:string){
 if(!validDate(s.from)||!validDate(s.to)||s.from>s.to)throw Error('导出日期范围无效')
 const active=new Set((await db.modules.toArray()).filter(m=>!m.archived).map(m=>m.id))
 const rows=(await db.records.toArray()).filter(r=>!r.deleted&&active.has(r.module_id)&&r.date>=s.from&&r.date<=s.to&&(!s.module||s.module===r.module_id)&&(r.type==='task'||s.notes&&r.type==='note'||s.module&&r.type!=='note')&&(s.status==='all'||r.status===s.status))
 const records=await Promise.all(rows.map(async r=>({id:r.id,updated_version:await recordVersion(r),updated_at:r.updated_at,source_id:r.source_id,module_id:r.module_id,type:r.type,title:r.title,date:r.date,status:r.status,deadline:r.properties.plan_deadline??'',planned_start:r.properties.planned_start??'',time_zone:r.properties.time_zone??'',...(s.body?{body:r.body}:{})})))
 const statistics:Record<string,number>={}
 if(s.stats){const selected=new Set(rows.map(r=>r.id)),sessions=(await db.sessions.toArray()).filter(r=>!s.module||r.subjectKind==='record'&&selected.has(r.subjectId));let day=s.from,count=0;while(day<=s.to){if(++count>366)throw Error('统计范围最多一年');statistics[day]=sessions.reduce((n,r)=>n+sessionMilliseconds(r,day),0);day=new Date(Date.parse(day+'T12:00:00Z')+86400000).toISOString().slice(0,10)}}
 const result={schema_version:'lifeos-context-v1',generated_at:new Date().toISOString(),sync_status:{reported_status:syncStatus,scope:'仅本机已保存数据；不保证其他设备均已手动同步'},selection:s,complete:true,records,...(s.stats?{daily_project_milliseconds:statistics}:{})}
 const text=JSON.stringify(result,null,2);if(text.length>262144)throw Error('快照超过上限，未导出任何内容；请缩小范围')
 return text
}
