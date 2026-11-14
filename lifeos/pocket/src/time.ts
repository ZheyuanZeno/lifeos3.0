import type { Session } from './model'
export const MIN_SESSION_MS=30000
export const isSessionPaused=(session:Session)=>!session.endedAt&&session.pauses?.at(-1)?.endedAt===null
function elapsedWithin(session:Session,lo:number,hi:number,now:number){
  const start=Math.max(Date.parse(session.startedAt),lo),end=Math.min(session.endedAt?Date.parse(session.endedAt):now,hi)
  if(end<=start)return 0
  const paused=(session.pauses??[]).reduce((sum,p)=>sum+Math.max(0,Math.min(p.endedAt?Date.parse(p.endedAt):end,end)-Math.max(Date.parse(p.startedAt),start)),0)
  return Math.max(0,end-start-paused)
}
export function sessionElapsed(session:Session,now=Date.now()){return elapsedWithin(session,-Infinity,Infinity,now)}
export function isHistorySession(session:Session){return !session.deleted&&session.endedAt!==null&&sessionElapsed(session)>MIN_SESSION_MS}
export function planMilliseconds(sessions:Session[],id:string,now=Date.now()){
  const seen=new Set<string>();return sessions.reduce((sum,s)=>{if(s.subjectKind!=='record'||s.subjectId!==id||s.deleted||seen.has(s.id)||(s.endedAt!==null&&!isHistorySession(s)))return sum;seen.add(s.id);return sum+sessionElapsed(s,now)},0)
}
const formatters = new Map<string,Intl.DateTimeFormat>()
export function dayAt(ms=Date.now(),timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone) {
  let fmt=formatters.get(timeZone)
  if(!fmt){fmt=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'});formatters.set(timeZone,fmt)}
  const parts=fmt.formatToParts(ms), get=(k:string)=>parts.find(p=>p.type===k)!.value
  return get('year')+'-'+get('month')+'-'+get('day')
}
// Locate each civil-day boundary in the recording time zone. DST days need not be 24 hours.
const ranges=new Map<string,[number,number]>()
export function dayRange(day:string,timeZone:string):[number,number] {
  const key=day+'/'+timeZone,cached=ranges.get(key);if(cached)return cached
  const anchor=Date.parse(day+'T00:00:00Z')
  const boundary=(after:boolean)=>{let lo=anchor-48*3600000,hi=anchor+72*3600000;while(hi-lo>1){const mid=Math.floor((hi+lo)/2);if(after?dayAt(mid,timeZone)<=day:dayAt(mid,timeZone)<day)lo=mid;else hi=mid}return hi}
  const range:[number,number]=[boundary(false),boundary(true)];if(ranges.size>=256)ranges.clear();ranges.set(key,range);return range
}
export function sessionMilliseconds(session:Session,day:string,now=Date.now()) {
  if(session.deleted||(session.endedAt!==null&&!isHistorySession(session)))return 0
  const [lo,hi]=dayRange(day,session.timeZone)
  return elapsedWithin(session,lo,hi,now)
}
export function totalMilliseconds(sessions:Session[],subjectId:string,day:string,now=Date.now()) {
  const seen=new Set<string>();return sessions.reduce((sum,s)=>{if(s.subjectId!==subjectId||seen.has(s.id))return sum;seen.add(s.id);return sum+sessionMilliseconds(s,day,now)},0)
}
export function duration(ms:number){const seconds=Math.max(0,Math.floor(ms/1000));return String(Math.floor(seconds/3600)).padStart(2,'0')+':'+String(Math.floor(seconds/60)%60).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0')}
export function weekday(day:string){return new Date(day+'T12:00:00Z').getUTCDay()}
