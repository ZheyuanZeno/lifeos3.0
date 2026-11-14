import {test,expect} from './fixtures'
import {syntheticMicrophone} from './audio-fixture'
import {GoogleAPI} from './google-fixture'
import {createHash} from 'node:crypto'
import type {Page} from '@playwright/test'
async function checkPlayer(page:Page){await expect(page.locator('audio')).toHaveCount(1);await expect(page.locator('audio')).toHaveAttribute('src',/^blob:/);if(await page.evaluate(()=>Boolean((window as any).__nativeRecorder)))await expect.poll(()=>page.locator('audio').evaluate((a:HTMLAudioElement)=>a.readyState)).toBeGreaterThan(0);else test.info().annotations.push({type:'environment',description:'Windows WebKit has no native recording/decoding; WAV fixture verifies persistence, UI and binary transport. Native encoding/playback is verified in Chromium.'})}
async function record(page:Page){
 await page.getByRole('link',{name:'随手记',exact:true}).click();await page.getByLabel('此刻的想法').fill('一段可编辑的语音笔记')
 await page.getByRole('button',{name:'录音',exact:true}).click();await expect(page.getByRole('button',{name:'停止并保存',exact:true})).toBeEnabled();await expect(page.locator('#recording-clock')).not.toHaveText('00:00:00')
 await page.getByRole('button',{name:'停止并保存',exact:true}).click();await expect(page.locator('#notice')).toHaveText('语音已保存在本地');await expect(page.locator('audio')).toHaveCount(1)
 await checkPlayer(page)
}
async function connect(page:Page){await page.getByRole('link',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'连接 Google Drive',exact:true}).click();await expect(page.getByRole('button',{name:'立即同步',exact:true})).toBeEnabled();await page.getByRole('button',{name:'立即同步',exact:true}).click();await expect(page.locator('#drive-status')).toHaveText('已同步')}
test('voice capture survives offline reopen and edits, exports bytes and reaches the original desktop',async({page,context,request,baseURL})=>{
 await syntheticMicrophone(context);await page.goto('/pocket/');await page.getByText('离线资源已就绪',{exact:true}).waitFor();await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise<void>(r=>navigator.serviceWorker.addEventListener('controllerchange',()=>r(),{once:true}))})
 await context.setOffline(true);await record(page);if(await page.evaluate(()=>Boolean((window as any).__nativeRecorder))){await page.locator('audio').evaluate(async(a:HTMLAudioElement)=>{await a.play()});await expect.poll(()=>page.locator('audio').evaluate((a:HTMLAudioElement)=>a.paused)).toBe(false);await page.locator('audio').evaluate((a:HTMLAudioElement)=>a.pause())};await page.close();const reopened=await context.newPage();await reopened.goto(baseURL+'/pocket/#capture');await expect(reopened.locator('audio')).toHaveCount(1);await checkPlayer(reopened)
 await reopened.getByRole('button',{name:'编辑随手记 一段可编辑的语音笔记',exact:true}).click();await reopened.getByLabel('标题',{exact:true}).fill('保留录音修改标题');await reopened.getByRole('button',{name:'保存',exact:true}).click();await expect(reopened.locator('.note-title')).toHaveText('保留录音修改标题');await expect(reopened.locator('audio')).toHaveCount(1)
 await context.setOffline(false);await reopened.getByRole('link',{name:'设置',exact:true}).click();await reopened.getByRole('button',{name:'与本机白板交换',exact:true}).click();await expect(reopened.locator('#notice')).toContainText('已与本机白板交换')
 const state=await(await request.get('/api/state')).json(),row=state.records.find((r:{title:string})=>r.title==='保留录音修改标题');expect(row.attachments).toHaveLength(1);const response=await request.get('/attachments/'+row.attachments[0].file);expect(response.ok()).toBe(true);const bytes=await response.body();expect(bytes.length).toBeGreaterThan(100)
 const download=reopened.waitForEvent('download');await reopened.getByRole('button',{name:'导出备份',exact:true}).click();const path=await(await download).path();const {readFile}=await import('node:fs/promises'),backup=JSON.parse(await readFile(path!,'utf8'));expect(backup.media).toHaveLength(1);expect(createHash('sha256').update(bytes).digest('hex')).toBe(backup.media[0].sha256);expect(Buffer.from(backup.media[0].data,'base64')).toEqual(bytes)
 await reopened.goto('/');await reopened.getByRole('button',{name:'保留录音修改标题',exact:true}).click();await expect(reopened.locator('#record-dialog audio')).toBeVisible()
})
test('Drive transfers playable binary audio between isolated devices and persists it in SQLite attachments',async({browser,baseURL,request})=>{
 const phoneContext=await browser.newContext({serviceWorkers:'block'}),desktopContext=await browser.newContext({serviceWorkers:'block'}),google=new GoogleAPI()
 try{
  await syntheticMicrophone(phoneContext);await google.attach(phoneContext);await google.attach(desktopContext);await phoneContext.route(baseURL+'/api/**',r=>r.fulfill({status:404,body:'{}'}))
  const phone=await phoneContext.newPage();await phone.goto(baseURL+'/pocket/');await record(phone);await connect(phone)
  const desktop=await desktopContext.newPage();await desktop.goto(baseURL+'/pocket/');await connect(desktop);await desktop.getByRole('link',{name:'随手记',exact:true}).click();await expect(desktop.locator('audio')).toHaveCount(1);await expect(desktop.locator('audio')).toHaveAttribute('src',/^blob:/)
  const state=await(await request.get('/api/state')).json(),row=state.records.find((r:{title:string})=>r.title==='一段可编辑的语音笔记'),file=await request.get('/attachments/'+row.attachments[0].file);expect(file.ok()).toBe(true)
  expect([...google.files.values()].filter(f=>f.appProperties.lifeosKind==='lifeos-audio-v1')).toHaveLength(1);const count=google.files.size;await desktop.getByRole('link',{name:'设置',exact:true}).click();await desktop.getByRole('button',{name:'立即同步',exact:true}).click();await expect(desktop.locator('#drive-status')).toHaveText('已同步');expect(google.files.size).toBe(count)
 }finally{google.release();await phoneContext.close();await desktopContext.close()}
})
