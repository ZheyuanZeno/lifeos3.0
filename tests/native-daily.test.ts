import {describe,it,expect} from 'vitest'
import {dailyProjection} from '../lifeos/pocket/src/native-daily'
import type {Session} from '../lifeos/pocket/src/model'
const session=(patch:Partial<Session>={}):Session=>({id:'session1',subjectId:'routine1',subjectKind:'routine',title:'学习',startedAt:'2026-11-15T10:00:00Z',endedAt:'2026-11-15T11:00:00Z',timeZone:'Europe/Berlin',deviceId:'device1',created_at:'2026-11-15T10:00:00Z',updated_at:'2026-11-15T11:00:00Z',note:'计时备注',...patch})
describe('native daily read projection',()=>{
 it('matches history and deducts pauses without exporting raw pause/device fields',async()=>{
  const rows=await dailyProjection([session({pauses:[{startedAt:'2026-11-15T10:10:00Z',endedAt:'2026-11-15T10:20:00Z'}]})],'2026-11-15','2026-11-15')
  expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({note:'计时备注',duration_ms:3000000,day_duration_ms:3000000,subject_kind:'routine'})
  expect(rows[0]).not.toHaveProperty('deviceId');expect(rows[0]).not.toHaveProperty('pauses')
 })
 it('omits deleted, active, <=30 second and out-of-range sessions',async()=>{
  const rows=await dailyProjection([session({deleted:true}),session({endedAt:null}),session({endedAt:'2026-11-15T10:00:30Z'}),session({startedAt:'2026-11-14T10:00:00Z',endedAt:'2026-11-14T11:00:00Z'})],'2026-11-15','2026-11-15');expect(rows).toEqual([])
 })
 it('splits cross-midnight duration by the original recording timezone and retains whole duration',async()=>{
  const rows=await dailyProjection([session({startedAt:'2026-11-14T22:30:00Z',endedAt:'2026-11-15T00:30:00Z'})],'2026-11-14','2026-11-15')
  expect(rows.map(r=>[r.date,r.day_duration_ms,r.duration_ms])).toEqual([['2026-11-14',1800000,7200000],['2026-11-15',5400000,7200000]])
 })
 it('retains independent parallel routine and plan timers, and deduplicates same IDs',async()=>{
  const a=session(),b=session({id:'session2',subjectKind:'record',subjectId:'plan1'})
  const rows=await dailyProjection([a,a,b],'2026-11-15','2026-11-15');expect(rows).toHaveLength(2);expect(rows.reduce((n,r)=>n+r.day_duration_ms,0)).toBe(7200000)
 })
 it('rejects invalid dates and oversized history rather than silently truncating',async()=>{
  await expect(dailyProjection([],'2026-02-30','2026-11-15')).rejects.toThrow()
  await expect(dailyProjection(Array.from({length:501},(_,n)=>session({id:'s'+n})),'2026-11-15','2026-11-15')).rejects.toThrow('500')
 })
})
