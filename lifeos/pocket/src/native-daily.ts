import type {Session} from './model'
import {validDate} from './model'
import {dayAt,isHistorySession,sessionElapsed,sessionMilliseconds} from './time'
import {digest} from './ai/protocol'

export async function dailyProjection(sessions:Session[],from:string,to:string){
 if(!validDate(from)||!validDate(to)||from>to||Date.parse(to)-Date.parse(from)>366*86400000)throw Error('当日记录日期范围无效')
 const rows=[];const seen=new Set<string>()
 for(const session of sessions){
  if(!isHistorySession(session)||seen.has(session.id))continue;seen.add(session.id)
  const started=dayAt(Date.parse(session.startedAt),session.timeZone),ended=dayAt(Date.parse(session.endedAt!),session.timeZone)
  const first=from>started?from:started,last=to<ended?to:ended
  if(first>last)continue
  const version=await digest(session)
  for(let day=first;day<=last;day=new Date(Date.parse(day+'T12:00:00Z')+86400000).toISOString().slice(0,10)){
   const within=sessionMilliseconds(session,day)
   if(within<=0&&day!==started)continue
   rows.push({id:session.id,subject_id:session.subjectId,subject_kind:session.subjectKind,title:session.title,date:day,started_at:session.startedAt,ended_at:session.endedAt!,time_zone:session.timeZone,duration_ms:sessionElapsed(session),day_duration_ms:within,note:session.note??'',updated_version:version})
   if(rows.length>500)throw Error('当日记录超过500段，请缩小授权日期范围；未上传不完整历史')
  }
 }
 return rows
}
