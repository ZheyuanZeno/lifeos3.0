import {test,expect} from './fixtures'
import {GoogleAPI} from './google-fixture'
import {syntheticMicrophone} from './audio-fixture'
import {createHash} from 'node:crypto'
test.use({serviceWorkers:'block'})
test('complete access publishes all entities and original recording, applies ideas/history, and reviews edits',async({page,context})=>{
 const google=new GoogleAPI();await google.attach(context);await syntheticMicrophone(context)
 let active='',staging:any[]=[],published:any[]=[],queue:any[]=[],full=false
 const receipts=new Map<string,string>(),media=new Map<string,{size:number;sha:string;parts:Map<number,Buffer>;ready:boolean}>()
 await context.route('**/api/mcp-device/**',async route=>{
  const action=new URL(route.request().url()).pathname.split('/').at(-1),b=route.request().postDataJSON();let result:any={}
  if(action==='enroll'){full=b.policy.full;result={token:'test-full-token',accountId:'mock-account'}}
  if(action==='pair')result={secret:'full-pair'}
  if(action==='business'){
   if(b.phase==='begin'){if(active!==b.generation)staging=[];result={published:active===b.generation,received:0,media_epoch:'test'}}
   if(b.phase==='page'){expect(b.rows.every((r:any)=>['modules','records','routines','sessions','completions'].includes(r.entity))).toBe(true);staging.push(...b.rows)}
   if(b.phase==='commit'){published=staging;active=b.generation;result={published:true}}
  }
  if(action==='media'){
   if(b.phase==='status'){if(!media.has(b.file))media.set(b.file,{size:b.size,sha:b.sha256,parts:new Map(),ready:false});const m=media.get(b.file)!;result={ready:m.ready,missing:Array.from({length:Math.ceil(m.size/98304)},(_,n)=>n).filter(n=>!m.parts.has(n)),chunk_size:98304}}
   if(b.phase==='chunk')media.get(b.file)!.parts.set(b.index,Buffer.from(b.data,'base64'))
   if(b.phase==='commit'){const m=media.get(b.file)!,bytes=Buffer.concat([...m.parts.entries()].sort((a,b)=>a[0]-b[0]).map(p=>p[1]));expect(bytes.length).toBe(m.size);expect(createHash('sha256').update(bytes).digest('hex')).toBe(m.sha);m.ready=true;result={ready:true}}
  }
  if(action==='pending')result={commands:queue.filter(c=>!receipts.has(c.command_id)),recent:[]}
  if(action==='ack'){receipts.set(b.command_id,b.status);expect(['applied','review','conflict','failed']).toContain(b.status)}
  await route.fulfill({contentType:'application/json',body:JSON.stringify(result)})
 })
 await page.goto('/pocket/');await page.getByRole('link',{name:'随手记',exact:true}).click();await page.getByLabel('此刻的想法').fill('原始录音备注');await page.getByRole('button',{name:'录音',exact:true}).click();await expect(page.locator('#recording-clock')).not.toHaveText('00:00:00');await page.getByRole('button',{name:'停止并保存',exact:true}).click();await expect(page.locator('audio')).toHaveCount(1)
 await page.getByRole('link',{name:'设置',exact:true}).click();await expect(page.getByRole('button',{name:'连接 Google Drive',exact:true})).toBeEnabled();await page.getByRole('button',{name:'连接 Google Drive',exact:true}).click();await expect(page.getByRole('button',{name:'立即同步',exact:true})).toBeEnabled()
 await page.getByRole('checkbox',{name:'完整业务访问（全部日期、模块、想法、历史、录音附件及编辑）',exact:true}).check();await page.getByRole('button',{name:'绑定设备并生成配对码',exact:true}).click()
 await expect.poll(()=>published.length).toBeGreaterThan(0);expect(full).toBe(true);await expect.poll(()=>[...media.values()].some(m=>m.ready)).toBe(true)
 expect(published.find(r=>r.entity==='records')?.data.body).toBe('原始录音备注')
 const routine=published.find(r=>r.entity==='routines'),make=(id:string,tool:string,args:any,review=false)=>({command_id:id,review,command:{protocol:'lifeos-native-v2',command_id:id,created_at:'2026-11-17T10:00:00Z',tool,args:{command_id:id,...args}}})
 queue=[make('full-idea','lifeos_create_idea',{data:{title:'从Claude新增想法',body:'完整正文',date:'2020-01-01'}}),make('full-history','lifeos_create_history',{data:{subject_kind:'routine',subject_id:routine.id,started_at:'2026-11-16T10:00:00Z',ended_at:'2026-11-16T11:00:00Z',time_zone:'Europe/Berlin',note:'从聊天补录'}})]
 await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await expect.poll(()=>receipts.get('full-idea')).toBe('applied');await expect.poll(()=>receipts.get('full-history')).toBe('applied')
 await expect.poll(()=>published.some(r=>r.entity==='records'&&r.data.title==='从Claude新增想法')).toBe(true);await expect.poll(()=>published.some(r=>r.entity==='sessions'&&r.data.note==='从聊天补录')).toBe(true)
 const idea=published.find(r=>r.entity==='records'&&r.data.title==='从Claude新增想法');queue.push(make('full-edit','lifeos_update_record',{id:idea.id,expected_version:idea.version,data:{title:'已审核修改想法'}},true))
 await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await expect(page.locator('#native-ai')).toContainText('待审核 full-edit');expect(receipts.has('full-edit')).toBe(false);await page.getByRole('button',{name:'确认应用',exact:true}).click();await expect.poll(()=>receipts.get('full-edit')).toBe('applied')
 await page.getByRole('link',{name:'随手记',exact:true}).click();await expect(page.getByRole('button',{name:'已审核修改想法',exact:true})).toBeVisible();await page.reload();await expect(page.getByRole('button',{name:'已审核修改想法',exact:true})).toBeVisible();expect(google.requests.filter(r=>r.path.includes('/upload/'))).toHaveLength(0);google.release()
})
