import {test,expect} from './fixtures'
import {GoogleAPI} from './google-fixture'
import type {BrowserContext} from '@playwright/test'
// Route mocks bypass SW interception (real SW handlers are exercised separately).
test.use({serviceWorkers:'block'})

async function pushBrowser(context:BrowserContext,denied=false){
 await context.addInitScript(({denied})=>{
  let active=sessionStorage.getItem('mock.push')==='yes'
  Object.defineProperty(window,'PushManager',{configurable:true,value:class{}})
  Object.defineProperty(window,'Notification',{configurable:true,value:class{static permission=sessionStorage.getItem('mock.push')==='yes'?'granted':'default'}})
  const sub={endpoint:'https://web.push.apple.com/browser-test',toJSON(){return {endpoint:this.endpoint,keys:{p256dh:'public-key',auth:'auth-key'}}},async unsubscribe(){active=false;sessionStorage.removeItem('mock.push');return true}}
  const pushManager={async getSubscription(){return active?sub:null},subscribe(){(window as any).__notificationGesture=navigator.userActivation?.isActive??true;if(denied)return Promise.reject(new DOMException('denied','NotAllowedError'));active=true;(window as any).Notification.permission='granted';sessionStorage.setItem('mock.push','yes');return Promise.resolve(sub)}}
  Object.defineProperty(navigator.serviceWorker,'ready',{configurable:true,value:Promise.resolve({pushManager})})
 },{denied})
}
async function api(context:BrowserContext){
 const calls:{path:string;method:string;data:any;authorization:string}[]=[]
 let fail=false,subscribed=false
 await context.route('**/api/notify/**',async route=>{
  const r=route.request(),path=new URL(r.url()).pathname.split('/').at(-1)!,data=r.method()==='GET'?null:r.postDataJSON()
  calls.push({path,method:r.method(),data,authorization:r.headers().authorization??''})
  let response:unknown={ok:true},status=200
  if(path==='config')response={ready:true,publicKey:'B'+'a'.repeat(86)}
  if(path==='enroll')response={token:'notification-device-token',accountId:'mock-account',expires:Date.now()+365*86400000}
  if(path==='subscription')subscribed=r.method()==='PUT'
  if(path==='status')response={subscribed,scheduled:0}
  if(path==='state'&&fail){response={error:'模拟网络失败'};status=503}
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(response)})
 })
 return {calls,fail:()=>{fail=true}}
}
async function connect(page:import('@playwright/test').Page){await page.goto('/pocket/#settings');await expect(page.getByRole('button',{name:'连接 Google Drive',exact:true})).toBeVisible();await page.getByRole('button',{name:'连接 Google Drive',exact:true}).click();await expect(page.getByRole('button',{name:'开启通知',exact:true})).toBeEnabled()}
test('user gesture enables push; metadata persists independently of Drive login and edits update scheduled reminders',async({page,context})=>{
 await pushBrowser(context);const google=new GoogleAPI();await google.attach(context);const mock=await api(context);await connect(page)
 await page.getByRole('button',{name:'开启通知',exact:true}).click();await expect(page.getByRole('button',{name:'发送测试通知',exact:true})).toBeVisible();expect(await page.evaluate(()=>(window as any).__notificationGesture)).toBe(true)
 await page.getByRole('button',{name:'发送测试通知',exact:true}).click();await expect(page.locator('#notice')).toContainText('测试通知已交给推送服务')
 await page.getByRole('link',{name:'每日日程',exact:true}).click();await page.getByRole('button',{name:'添加计划项目'}).click();await page.getByLabel('计划名称').fill('推送计划');await page.getByLabel('详细时间（可选）').fill('20:01');await page.getByLabel('备注',{exact:true}).fill('private reminder body');await page.getByRole('button',{name:'保存',exact:true}).click()
 await expect.poll(()=>mock.calls.filter(c=>c.path==='state').some(c=>JSON.stringify(c.data).includes('推送计划'))).toBe(true)
 expect(mock.calls.filter(c=>c.path==='state').every(c=>!JSON.stringify(c.data).includes('private reminder body'))).toBe(true)
 const enrolled=mock.calls.filter(c=>c.path==='enroll').length
 await page.reload();await page.getByRole('link',{name:'设置',exact:true}).click();await expect(page.getByRole('button',{name:'连接 Google Drive',exact:true})).toBeVisible();await expect.poll(()=>mock.calls.filter(c=>c.path==='state').length).toBeGreaterThan(1);expect(mock.calls.filter(c=>c.path==='enroll').length).toBe(enrolled)
 expect(mock.calls.filter(c=>c.path==='state').at(-1)?.authorization).toBe('Bearer notification-device-token')
 await page.getByRole('button',{name:'关闭通知',exact:true}).click();await expect(page.getByRole('button',{name:'开启通知',exact:true})).toBeEnabled();expect(mock.calls.some(c=>c.path==='subscription'&&c.method==='DELETE')).toBe(true)
})
test('denied permission preserves normal plans and offline failure stays visible',async({page,context})=>{
 await pushBrowser(context,true);await new GoogleAPI().attach(context);const mock=await api(context);await connect(page);await page.getByRole('button',{name:'开启通知',exact:true}).click();await expect(page.locator('#notice')).toContainText('通知权限未开启');expect(mock.calls.some(c=>c.path==='subscription'&&c.method==='PUT')).toBe(false)
 mock.fail();await page.getByRole('link',{name:'每日日程',exact:true}).click();await page.getByRole('button',{name:'添加计划项目'}).click();await page.getByLabel('计划名称').fill('网络失败也能保存');await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.locator('#notice')).toHaveText('修改已保存在本地');await page.getByRole('link',{name:'设置',exact:true}).click();await expect(page.getByText('提醒变更未上传',{exact:true})).toBeVisible();await expect(page.getByText('模拟网络失败',{exact:true})).toBeVisible()
})
test('notification click opens the plan editor without starting or completing it',async({page})=>{
 await page.goto('/pocket/');await page.getByRole('button',{name:'添加计划项目'}).click();await page.getByLabel('计划名称').fill('通知跳转');await page.getByRole('button',{name:'保存',exact:true}).click()
 const id=await page.locator('[data-edit-plan]').first().getAttribute('data-edit-plan');await page.goto('/pocket/?plan='+id+'#daily');await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByLabel('计划名称')).toHaveValue('通知跳转');await expect(page.getByRole('region',{name:'当前计时'})).toHaveCount(0);expect(page.url()).not.toContain('?plan=')
})
test('a browser without push support still publishes completions that cancel reminders on other devices',async({page,context})=>{
 await context.addInitScript(()=>{delete (window as unknown as Record<string,unknown>).PushManager})
 await new GoogleAPI().attach(context);const mock=await api(context)
 await page.goto('/pocket/#settings');await expect(page.getByRole('button',{name:'连接 Google Drive',exact:true})).toBeEnabled();await page.getByRole('button',{name:'连接 Google Drive',exact:true}).click();await expect(page.getByRole('button',{name:'立即同步',exact:true})).toBeEnabled()
 await page.getByRole('link',{name:'每日日程',exact:true}).click();await page.getByRole('button',{name:'添加计划项目'}).click();await page.getByLabel('计划名称').fill('另一台设备取消提醒');await page.getByRole('button',{name:'保存',exact:true}).click()
 await page.getByRole('checkbox',{name:'完成 另一台设备取消提醒',exact:true}).click()
 await expect.poll(()=>mock.calls.filter(c=>c.path==='state').some(c=>c.data.operations.some((o:any)=>o.patch.status==='done'))).toBe(true)
 expect(mock.calls.some(c=>c.path==='subscription'&&c.method==='PUT')).toBe(false)
})
test.describe('native push capability before permission',()=>{
 test.use({serviceWorkers:'allow'})
 test('ready notification service does not block first offline installation before system consent',async({page,context})=>{
  // SW-controlled requests bypass route mocks; isolate config while retaining
  // the real service worker and native permission APIs for this regression.
  await context.addInitScript(()=>{const realFetch=window.fetch.bind(window);window.fetch=(input,init)=>new URL(input instanceof Request?input.url:String(input),location.href).pathname==='/api/notify/config'?Promise.resolve(new Response(JSON.stringify({ready:true,publicKey:'B'+'a'.repeat(86)}),{headers:{'Content-Type':'application/json'}})):realFetch(input,init)})
  await new GoogleAPI().attach(context)
  await page.goto('/pocket/');await expect(page.getByText('离线资源已就绪',{exact:true})).toBeVisible()
  expect(await page.evaluate(()=>Notification.permission)).not.toBe('granted')
  await page.getByRole('link',{name:'设置',exact:true}).click();await expect(page.getByRole('heading',{name:'计划通知',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'开启通知',exact:true})).toBeDisabled()
  await context.setOffline(true);await page.close();const offline=await context.newPage();await offline.goto('/pocket/');await offline.getByRole('link',{name:'随手记',exact:true}).click();await offline.getByLabel('此刻的想法').fill('通知未授权时也能离线记录');await offline.getByRole('button',{name:'保存随手记',exact:true}).click();await expect(offline.getByRole('button',{name:'通知未授权时也能离线记录',exact:true})).toBeVisible()
 })
})
