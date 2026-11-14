import {test,expect} from './fixtures'
import type {Page} from '@playwright/test'
import {GoogleAPI,MEMORY_TOKEN} from './google-fixture'
// Mock API traffic must bypass service workers; separate pocket.spec tests cover real offline caching.
test.use({serviceWorkers:'block'})
async function settings(page:Page){await page.getByRole('link',{name:'设置',exact:true}).click()}
async function connect(page:Page){await settings(page);await expect(page.getByRole('button',{name:'连接 Google Drive',exact:true})).toBeEnabled();await page.getByRole('button',{name:'连接 Google Drive',exact:true}).click();await expect(page.getByRole('button',{name:'立即同步',exact:true})).toBeEnabled();await page.getByRole('button',{name:'立即同步',exact:true}).click();await expect(page.locator('#drive-status')).toHaveText('已同步')}
async function capture(page:Page,title:string){await page.getByRole('link',{name:'随手记',exact:true}).click();await page.getByLabel('此刻的想法').fill(title);await page.getByRole('button',{name:'保存随手记'}).click();await expect(page.locator('#notice')).toHaveText('随手记已保存在本地')}
async function history(page:Page){await page.getByRole('link',{name:'随手记',exact:true}).click()}
async function pull(page:Page){await settings(page);await expect(page.getByRole('button',{name:'立即同步',exact:true})).toBeEnabled();await page.getByRole('button',{name:'立即同步',exact:true}).click();await expect(page.locator('#drive-status')).toHaveText('已同步')}

test('authorization and local edits leave the sync button idle until the user clicks it',async({page,context})=>{
 const google=new GoogleAPI();await google.attach(context);await page.goto('/pocket/');await settings(page)
 await expect(page.getByRole('button',{name:'连接 Google Drive',exact:true})).toBeEnabled();await page.getByRole('button',{name:'连接 Google Drive',exact:true}).click();await expect(page.getByRole('button',{name:'立即同步',exact:true})).toBeEnabled()
 expect(google.files.size).toBe(0);expect(google.requests.every(r=>r.path.endsWith('/about'))).toBe(true)
 const requests=google.requests.length
 await capture(page,'只在手动点击后上传');await settings(page);await expect(page.locator('#drive-status')).toContainText('等待同步');await expect(page.getByRole('button',{name:'立即同步',exact:true})).toBeEnabled()
 await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('pageshow'));document.dispatchEvent(new Event('visibilitychange'))})
 // Covers both the removed edit debounce and the former foreground polling period.
 await page.waitForTimeout(3200);expect(google.requests).toHaveLength(requests);expect(google.files.size).toBe(0);await expect(page.getByRole('button',{name:'立即同步',exact:true})).toBeEnabled()
 await pull(page);expect(google.files.size).toBeGreaterThan(0);const uploaded=google.files.size
 await page.reload();await expect(page.getByRole('button',{name:'连接 Google Drive',exact:true})).toBeEnabled();expect(google.files.size).toBe(uploaded)
})

test('two isolated browser databases exchange through Drive and bridge to SQLite without storing tokens',async({browser,baseURL,request})=>{
 const a=await browser.newContext({serviceWorkers:'block'}),b=await browser.newContext({serviceWorkers:'block'}),google=new GoogleAPI()
 try{
  await google.attach(a);await google.attach(b)
  // The phone cannot access any local Python bridge. Shared records must travel through Drive.
  await b.route(baseURL+'/api/**',route=>route.fulfill({status:404,body:'{}'}))
  const desktop=await a.newPage(),phone=await b.newPage();await phone.goto(baseURL+'/pocket/');await capture(phone,'手机经云端传给电脑');await connect(phone)
  expect(await phone.evaluate(()=>({scope:(window as any).__requestedScopes,direct:(window as any).__authWasDirect}))).toEqual({scope:'https://www.googleapis.com/auth/drive.appdata',direct:true})
  await desktop.goto(baseURL+'/pocket/');await connect(desktop);await history(desktop);await expect(desktop.getByRole('button',{name:'手机经云端传给电脑',exact:true})).toBeVisible()
  let state=await (await request.get('/api/state')).json();expect(state.records.filter((r:{title:string})=>r.title==='手机经云端传给电脑')).toHaveLength(1)
  await capture(desktop,'电脑经云端传回手机');await pull(desktop);await pull(phone);await history(phone);await expect(phone.getByRole('button',{name:'电脑经云端传回手机',exact:true})).toBeVisible()
  const count=google.files.size;await pull(phone);await pull(desktop);expect(google.files.size).toBe(count)
  for(const page of [desktop,phone]){
   const persisted=await page.evaluate(async()=>{
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{const open=indexedDB.open('lifeos-pocket-v1');open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error)})
    const data=await Promise.all([...db.objectStoreNames].map(name=>new Promise<unknown[]>((resolve,reject)=>{const request=db.transaction(name).objectStore(name).getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})));db.close();return JSON.stringify([data,localStorage,sessionStorage])
   });expect(persisted).not.toContain(MEMORY_TOKEN)
  }
 }finally{google.release();await a.close();await b.close()}
})

test('capture stays available during cloud upload and after expired authorization',async({page,context})=>{
 const google=new GoogleAPI();await google.attach(context);await page.goto('/pocket/');await connect(page)
 try{
  google.pauseUploads=true;await capture(page,'上传暂停时第一条');await settings(page);await page.getByRole('button',{name:'立即同步',exact:true}).click();await expect(page.locator('#drive-status')).toContainText('正在同步')
  await capture(page,'同步期间仍可保存');google.release();await settings(page);await expect(page.locator('#drive-status')).toHaveText('已同步')
  google.unauthorized=true;await page.getByRole('button',{name:'立即同步',exact:true}).click();await expect(page.locator('#drive-status')).toContainText('授权已过期')
  await capture(page,'授权过期后保存在本地');await history(page);await expect(page.getByRole('button',{name:'同步期间仍可保存',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'授权过期后保存在本地',exact:true})).toBeVisible()
 }finally{google.release()}
})
