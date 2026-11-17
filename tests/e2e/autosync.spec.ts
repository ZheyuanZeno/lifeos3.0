import {test,expect} from './fixtures'
import {Miniflare} from 'miniflare'
import {build} from 'esbuild'
import {createHash,randomBytes,webcrypto} from 'node:crypto'
import type {Page} from '@playwright/test'
const sha=(s:string)=>createHash('sha256').update(s).digest('hex')
const canonical=(v:any):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}'
const bootstrap=randomBytes(32).toString('hex')
let mf:Miniflare
test.beforeAll(async()=>{
 const bundle=await build({entryPoints:['workers/sync/src/index.ts'],bundle:true,write:false,format:'esm',platform:'node',target:'es2023',external:['node:*','cloudflare:*']})
 mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-08-01',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],durableObjects:{SPACES:{className:'SyncSpace',useSQLite:true},LIMITER:{className:'SyncLimiter',useSQLite:true}},bindings:{SYNC_CREATE_HASH:sha(bootstrap)}})
 process.env.LIFEOS_SYNC_TEST_ENDPOINT=(await mf.ready).origin
})
test.afterAll(async()=>{delete process.env.LIFEOS_SYNC_TEST_ENDPOINT;await mf?.dispose()})
test('pairs nonexportable device keys and automatically exchanges offline notes after verified migration',async({page,browser,baseURL,request})=>{
 test.setTimeout(120000)
 const space=randomBytes(32).toString('hex'),device=randomBytes(16).toString('hex'),key=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify'])
 const other=await browser.newContext({baseURL,acceptDownloads:true,viewport:{width:320,height:780}}),second=await other.newPage()
 async function rpc(action:string,value:unknown={}){
  const body=JSON.stringify(value),stamp=String(Date.now()),nonce=randomBytes(16).toString('hex'),signature=await webcrypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key.privateKey,Buffer.from(JSON.stringify(['lifeos-sync-auth-v1',space,device,action,stamp,nonce,sha(body)])))
  const r=await mf.dispatchFetch('https://sync.test/v1/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-LifeOS-Space':space,'X-LifeOS-Device':device,'X-LifeOS-Time':stamp,'X-LifeOS-Nonce':nonce,'X-LifeOS-Signature':Buffer.from(signature).toString('base64')},body});const result:any=await r.json();expect(r.status,JSON.stringify(result)).toBe(200);return result
 }
 async function pair(p:Page,label:string){
  await p.goto('/pocket/#settings');await expect(p.locator('#sync-pair')).toBeVisible();await p.getByLabel('同步空间编号').fill(space);await p.getByLabel('本设备名称').fill(label);await p.getByRole('button',{name:'申请设备配对',exact:true}).click()
  const code=p.getByLabel('将以下信息交给已绑定的电脑或管理设备');await expect(code).toBeVisible();const info=JSON.parse(await code.inputValue());await rpc('pair/approve',{...info,role:'member'});await p.getByRole('button',{name:'已在电脑批准，完成绑定',exact:true}).click();await expect(p.locator('#auto-sync')).toContainText('迁移校验中')
 }
 async function verify(p:Page){await p.locator('#sync-source-confirm').check();const download=p.waitForEvent('download');await p.getByRole('button',{name:'下载备份并校验本机',exact:true}).click();await download;await expect(p.locator('#auto-sync')).toContainText('本机清单已核验')}
 async function note(p:Page,title:string){await p.getByRole('link',{name:'随手记',exact:true}).click();await p.getByLabel('此刻的想法').fill(title);await p.getByRole('button',{name:'保存随手记',exact:true}).click();await expect(p.locator('#notice')).toContainText('已保存在本地')}
 try{
  await rpc('create',{bootstrap,public_key:await webcrypto.subtle.exportKey('jwk',key.publicKey),recovery_hash:sha('fixture recovery only'),kind:'archive'})
  const archive_id=randomBytes(32).toString('hex'),storage_id=randomBytes(32).toString('hex');await rpc('archive/register',{archive_id,storage_id,primary_os:'windows'})
  // Real legacy desktop files belong to a deleted record; the old visible-audio bridge omits them.
  const desktop=await(await request.get('/api/state')).json(),audioFile='f'.repeat(32)+'.m4a',audioBytes=Buffer.from('historical audio fixture'),pdfBytes=Buffer.from('%PDF-historical-fixture')
  expect((await request.post('/api/pocket/media/'+audioFile,{headers:{'X-LifeOS-Token':desktop.token,'Content-Type':'audio/mp4'},data:audioBytes})).ok()).toBe(true)
  const pdf=await(await request.post('/api/attachment',{headers:{'X-LifeOS-Token':desktop.token},data:{name:'historical.pdf',data:pdfBytes.toString('base64')}})).json()
  const module={name:'Historical fixture',kind:'custom',view:'list',fields:[],archived:false,layout:null},stamp='2026-11-01T10:00:00.000Z',attachments=[{file:audioFile,name:'Historical audio'},pdf]
  const row={module_id:'legacy-module',type:'note',date:'2026-11-01',title:'Deleted historical fixture',body:'',time_label:'',amount:null,currency:'',status:'todo',source_id:'',attachments,properties:{},created_at:stamp,updated_at:stamp,deleted:true}
  const operations=[{id:'legacy-module-op',deviceId:'legacy-fixture',sequence:1,clock:1,context:{},entity:'modules',recordId:'legacy-module',patch:module,timestamp:stamp,uploaded:0},{id:'legacy-note-op',deviceId:'legacy-fixture',sequence:2,clock:2,context:{'legacy-fixture':1},entity:'records',recordId:'legacy-note',patch:row,timestamp:stamp,uploaded:0}]
  expect((await request.post('/api/pocket/exchange',{headers:{'X-LifeOS-Token':desktop.token},data:{protocol:1,operations}})).ok()).toBe(true)
  await pair(page,'Fixture first');await pair(second,'Fixture second')
  await page.locator('#auto-sync details').evaluate((e:HTMLDetailsElement)=>e.open=true);await second.locator('#auto-sync details').evaluate((e:HTMLDetailsElement)=>e.open=true)
  await verify(page);await verify(second);await verify(page)
  expect((await rpc('media/status',{file:audioFile})).sha).toBe(sha(audioBytes.toString()))
  expect((await rpc('media/status',{file:pdf.file})).sha).toBe(sha(pdfBytes.toString()))
  const status=await rpc('status'),events=await rpc('changes',{after:0,until:status.head,limit:100})
  expect(events.next_after).toBeNull()
  // Controlled protocol fixture only; physical archive/fsync is tested by the Python workerd harness.
  const proof=sha(canonical(events.items.map((c:any)=>({seq:c.seq,kind:c.kind,id:c.id,digest:c.digest??c.sha}))))
  await rpc('archive/ack',{archive_id,storage_id,cursor:status.head,manifest:proof});await rpc('activate')
  for(const p of [page,second]){await p.getByRole('button',{name:'刷新状态',exact:true}).click();await expect(p.locator('#auto-sync')).toContainText('已启用')}
  await note(page,'Automatic fixture note');await expect.poll(async()=>(await rpc('status')).head).toBeGreaterThan(status.head)
  await second.evaluate(()=>window.dispatchEvent(new Event('online')));await second.getByRole('link',{name:'随手记',exact:true}).click();await expect(second.getByText('Automatic fixture note',{exact:true})).toBeVisible()
  await other.setOffline(true);await note(second,'Offline fixture note');await second.reload();await expect(second.getByText('Offline fixture note',{exact:true})).toBeVisible();await other.setOffline(false)
  await expect.poll(async()=>(await rpc('status')).head).toBeGreaterThan(status.head+1)
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect(page.getByText('Offline fixture note',{exact:true})).toBeVisible()
  expect(await second.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
 }finally{await other.close()}
})
