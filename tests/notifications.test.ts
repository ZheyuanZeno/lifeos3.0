import {expect,it} from 'vitest'
import {generateVAPIDKeys} from 'web-push'
import {createECDH,randomBytes} from 'node:crypto'
import {projectReminders,reminderSchedule,validateProjection} from '../lifeos/pocket/src/notifications/projection'
import type {Operation} from '../lifeos/pocket/src/model'
import {sign,verify,subscription} from '../workers/notify/src/security'
import {sendPush} from '../workers/notify/src/push'
const make=(patch:Record<string,unknown>,extra:Partial<Operation>={}):Operation=>({id:'a1',deviceId:'a',sequence:1,clock:1,context:{},entity:'records',recordId:'task1',timestamp:'2026-11-14T08:00:00Z',uploaded:0,patch,...extra})
const base=()=>make({type:'task',title:'复习',status:'todo',deleted:false,module_id:'plans',properties:{planned_start:'2026-11-14T12:01:00Z',time_zone:'Europe/Berlin',secret:'private'},body:'private note',attachments:[{file:'private'}]})
it('projects only reminder metadata, retaining completion/removal operations and excluding unrelated personal content',()=>{
 const ops=projectReminders([base(),make({status:'done'},{id:'a2',sequence:2,clock:2,context:{a:1}}),make({type:'note',title:'private note'},{id:'n1',recordId:'note'}),make({title:'private timer'},{id:'s1',entity:'sessions'}),make({archived:false,name:'private module'},{id:'m1',recordId:'plans',entity:'modules'})])
 validateProjection(ops);expect(JSON.stringify(ops)).not.toContain('private');expect(reminderSchedule(ops)).toEqual([])
 expect(reminderSchedule(projectReminders([base()]))[0]).toMatchObject({id:'task1',title:'复习',at:Date.parse('2026-11-14T12:01:00Z')})
})
it('old snapshots cannot resurrect completion, deletion or archived plans; explicit causal reopen still works',()=>{
 const done=make({status:'done'},{id:'b1',deviceId:'b',clock:2,context:{a:1}})
 const stale=make({title:'older edit'},{id:'c1',deviceId:'c',clock:20,context:{a:1}})
 expect(reminderSchedule(projectReminders([base(),stale,done]))).toEqual([])
 const reopen=make({status:'todo'},{id:'a2',clock:21,sequence:2,context:{a:1,b:1,c:1}})
 expect(reminderSchedule(projectReminders([base(),stale,done,reopen]))).toHaveLength(1)
 for(const op of [make({deleted:true},{id:'d1',deviceId:'d',clock:3,context:{a:1}}),make({archived:true},{entity:'modules',recordId:'plans',id:'m1'})])expect(reminderSchedule(projectReminders([base(),stale,op]))).toEqual([])
})
it('changing or clearing detailed time cancels the old schedule and DDL alone does not invent a time',()=>{
 const change=make({properties:{planned_start:'2026-11-15T06:30:00Z'}},{id:'a2',sequence:2,clock:2,context:{a:1}})
 expect(reminderSchedule(projectReminders([base(),change]))).toEqual([{id:'task1',title:'复习',at:Date.parse('2026-11-15T06:30:00Z'),key:'task1_'+Date.parse('2026-11-15T06:30:00Z')}])
 expect(reminderSchedule(projectReminders([base(),{...change,patch:{properties:{planned_start:'',plan_deadline:'2026-11-16'}}}]))).toEqual([])
 expect(()=>validateProjection([base()])).toThrow('提醒')
})
it('long-lived device credentials are signed, scoped and expiring without containing a Google token',async()=>{
 const claim={account:'abc123',device:'phone',nonce:'nonce',expires:Date.now()+10000},secret='test-secret-only'
 const token=await sign(claim,secret);expect(await verify(token,secret)).toEqual(claim)
 await expect(verify(token+'x',secret)).rejects.toThrow('失效');await expect(verify(token,secret,claim.expires)).rejects.toThrow('失效');await expect(verify(token,'different-secret')).rejects.toThrow('失效')
})
it('validates push destinations and creates an encrypted, authenticated Web Push request',async()=>{
 const keys=generateVAPIDKeys(),ecdh=createECDH('prime256v1');ecdh.generateKeys()
 const sub=subscription({endpoint:'https://web.push.apple.com/test',keys:{p256dh:ecdh.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}})
 for(const endpoint of ['http://web.push.apple.com/test','https://localhost/test','https://evil-web.push.apple.com.evil/test','https://user@web.push.apple.com/test','https://web.push.apple.com:81/test'])expect(()=>subscription({...sub,endpoint})).toThrow()
 let called=false
 const fetcher:typeof fetch=async(input,init)=>{called=true;expect(String(input)).toBe(sub.endpoint);expect(init?.redirect).toBe('manual');expect(init?.headers).toMatchObject({'Content-Encoding':'aes128gcm',TTL:900});expect(String((init!.headers as Record<string,string>).Authorization)).toContain('vapid');expect(Buffer.from(init!.body as Uint8Array).toString()).not.toContain('private plan');return new Response(null,{status:201})}
 expect(await sendPush({VAPID_PUBLIC_KEY:keys.publicKey,VAPID_PRIVATE_KEY:keys.privateKey},sub,{title:'private plan',body:'due',tag:'test'},fetcher)).toBe(201);expect(called).toBe(true)
})
