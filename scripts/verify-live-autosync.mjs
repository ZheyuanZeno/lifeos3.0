import {chromium} from '@playwright/test'
import {mkdtemp,rm} from 'node:fs/promises'
import {spawn} from 'node:child_process'
import path from 'node:path'
import assert from 'node:assert/strict'
import {createHash,randomBytes} from 'node:crypto'
const root=await mkdtemp('E:/Codex/tmp/lifeos-live-sync-'),config=path.join(root,'agent.json'),python=process.env.LIFEOS_ARCHIVE_PYTHON??'E:/Codex/venvs/lifeos-archive/Scripts/python.exe'
const bootstrap=process.env.LIFEOS_SYNC_BOOTSTRAP_FILE??'E:/Codex/sync-config/bootstrap.txt'
function admin(action,value={}){return new Promise((resolve,reject)=>{const child=spawn(python,['tests/live_sync_admin.py','--config',config,'--action',action,...(action==='init'?['--bootstrap-file',bootstrap]:[])],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:process.env});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('error',reject);child.on('close',code=>{if(code!==0)reject(Error(err));else try{resolve(JSON.parse(out))}catch{reject(Error('Acceptance helper returned invalid JSON'))}});child.stdin.end(JSON.stringify(value))})}
const browser=await chromium.launch(),contexts=[]
async function pair(page,space,label){
 await page.goto('https://lifeos-pocket.pages.dev/pocket/#settings');await page.getByLabel('同步空间编号').fill(space);await page.getByLabel('本设备名称').fill(label);await page.getByRole('button',{name:'申请设备配对',exact:true}).click()
 const box=page.getByLabel('将以下信息交给已绑定的电脑或管理设备');await box.waitFor();const info=JSON.parse(await box.inputValue());await admin('pair/approve',{...info,role:'member'});await page.getByRole('button',{name:'已在电脑批准，完成绑定',exact:true}).click();await page.locator('#auto-sync').filter({hasText:'设备已连接'}).waitFor()
}
async function verify(page){await page.locator('#sync-source-confirm').check();const download=page.waitForEvent('download');await page.getByRole('button',{name:'开启自动同步',exact:true}).click();await download;await page.getByRole('button',{name:'备份已保存，继续',exact:true}).click();await page.locator('#auto-sync').filter({hasText:'本机已准备好'}).waitFor()}
async function waitFor(fn,timeout=45000){const start=Date.now();while(Date.now()-start<timeout){if(await fn())return;await new Promise(r=>setTimeout(r,500))}throw Error('Live automatic synchronization did not finish in time')}
try{
 const {space_id}=await admin('init');await admin('archive-once')
 for(let i=0;i<2;i++){const context=await browser.newContext({acceptDownloads:true,viewport:{width:390,height:844}});contexts.push(context);await pair(await context.newPage(),space_id,'Live synthetic fixture '+i)}
 const [a,b]=contexts.map(c=>c.pages()[0])
 await verify(a);await verify(b)
 await waitFor(async()=>{await admin('archive-once');return (await admin('status')).mode==='active'},90000)
 for(const page of [a,b])await page.locator('#auto-sync').filter({hasText:'自动同步已开启'}).waitFor({timeout:45000})
 const before=await admin('status'),title='Live automatic fixture '+randomBytes(6).toString('hex')
 await a.getByRole('link',{name:'随手记',exact:true}).click();await a.getByLabel('此刻的想法').fill(title);await a.getByRole('button',{name:'保存随手记',exact:true}).click()
 await waitFor(async()=>(await admin('status')).head>before.head)
 await b.evaluate(()=>window.dispatchEvent(new Event('online')));await b.getByRole('link',{name:'随手记',exact:true}).click();await b.getByText(title,{exact:true}).waitFor()
 // Close both browser clients before invoking the independent archive program.
 await Promise.all(contexts.map(c=>c.close()));contexts.length=0
 await admin('archive-once');const record=await admin('inspect',{title});assert.equal(record.count,1);assert.equal(record.body_sha256,createHash('sha256').update(title).digest('hex'));assert.equal(record.integrity,'ok')
 console.log('PASS: production HTTPS PWA -> real Sync Worker -> second isolated PWA -> closed browsers -> independent Python/SQLite durable archive; no Google authorization and no manual business sync')
}finally{await Promise.all(contexts.map(c=>c.close()));await browser.close();const resolved=path.resolve(root);assert.ok(resolved.startsWith(path.resolve('E:/Codex/tmp')+path.sep)&&path.basename(resolved).startsWith('lifeos-live-sync-'));await rm(resolved,{recursive:true,force:true})}
