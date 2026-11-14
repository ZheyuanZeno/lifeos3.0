import type {LifeRecord,Module} from './model'
import {validDate} from './model'
import {dayAt,dayRange} from './time'
export interface PlanScheduleInput {deadline?:string;plannedTime?:string;timeZone?:string}
const clocks=new Map<string,Intl.DateTimeFormat>()
export function minuteClock(instant:string,timeZone:string){
  let formatter=clocks.get(timeZone);if(!formatter){formatter=new Intl.DateTimeFormat('en-GB',{timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});clocks.set(timeZone,formatter)}
  return formatter.format(new Date(instant))
}
export const planTimeZone=(plan:LifeRecord)=>plan.properties.time_zone||Intl.DateTimeFormat().resolvedOptions().timeZone
export const plannedTime=(plan:LifeRecord)=>plan.properties.planned_start?minuteClock(plan.properties.planned_start,planTimeZone(plan)):''
export function planSchedule(properties:Record<string,string>,date:string,input:PlanScheduleInput){
  const next={...properties}
  if(input.deadline!==undefined){if(typeof input.deadline!=='string'||input.deadline&&!validDate(input.deadline))throw Error('DDL 日期无效');if(input.deadline||'plan_deadline' in next)next.plan_deadline=input.deadline}
  if(input.plannedTime!==undefined){
    if(typeof input.plannedTime!=='string'||input.plannedTime&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.plannedTime))throw Error('计划时间请精确到分钟')
    if(!input.plannedTime){if('planned_start' in next)next.planned_start=''}
    else{
      if(!validDate(date))throw Error('计划日期无效')
      const timeZone=input.timeZone||properties.time_zone||Intl.DateTimeFormat().resolvedOptions().timeZone
      try{new Intl.DateTimeFormat('en',{timeZone})}catch{throw Error('计划时区无效')}
      // Keep an existing instant when editing unrelated fields, including a DST fold.
      let instant=properties.planned_start
      if(!instant||dayAt(Date.parse(instant),timeZone)!==date||minuteClock(instant,timeZone)!==input.plannedTime){
        const [start,end]=dayRange(date,timeZone);instant=''
        for(let ms=start;ms<end;ms+=60000)if(minuteClock(new Date(ms).toISOString(),timeZone)===input.plannedTime){instant=new Date(ms).toISOString();break}
        if(!instant)throw Error('该日期的这个时间不存在，请重新选择')
      }
      next.planned_start=instant;next.time_zone=timeZone
    }
  }
  return next
}
// Carry unfinished single-use plans forward; they never become repeating routines.
export function plansForDate(records:LifeRecord[],modules:Module[],date:string,includeFuture=false){
  const activeModules=new Set(modules.filter(m=>!m.archived).map(m=>m.id))
  return records.filter(r=>r.type==='task'&&!r.deleted&&(includeFuture||r.date<=date)&&activeModules.has(r.module_id)).toSorted((a,b)=>a.date.localeCompare(b.date)||a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id))
}
