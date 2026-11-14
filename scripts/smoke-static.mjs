import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve,extname,sep } from 'node:path'
import { chromium,webkit } from 'playwright'
import assert from 'node:assert/strict'
const root=resolve('release/site')
const server=createServer(async(req,res)=>{try{const pathname=new URL(req.url,'http://local').pathname;if(pathname==='/pocket/index.html'){res.writeHead(308,{Location:'/pocket/'});res.end();return}const target=resolve(root,'.'+decodeURIComponent(pathname)+(pathname.endsWith('/')?'index.html':''));if(!target.startsWith(root+sep))throw Error('Invalid path');const data=await readFile(target);res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'})[extname(target)]??'application/octet-stream');res.end(data)}catch{res.writeHead(404);res.end('Not found')}})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const origin='http://127.0.0.1:'+server.address().port
try{for(const [name,engine] of [['Chromium',chromium],['WebKit',webkit]]){
 const browser=await engine.launch();try{
  const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage()
  await page.goto(origin+'/');await page.waitForURL('**/pocket/');await page.locator('.daily-toolbar').waitFor();await page.getByText('离线资源已就绪',{exact:true}).waitFor()
  assert.equal(await page.getByRole('link',{name:'返回白板'}).count(),0);assert.equal(await page.locator('#update').isVisible(),false)
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}))})
  await context.setOffline(true);await page.close();const offline=await context.newPage();await offline.goto(origin+'/pocket/')
  await offline.locator('.daily-toolbar').waitFor();await offline.getByRole('link',{name:'随手记',exact:true}).click();await offline.getByLabel('此刻的想法').fill('独立静态安装离线记录');await offline.getByRole('button',{name:'保存随手记'}).click();await offline.getByRole('status').filter({hasText:'随手记已保存在本地'}).waitFor();await offline.getByRole('button',{name:'独立静态安装离线记录',exact:true}).waitFor();await offline.reload();await offline.getByRole('button',{name:'独立静态安装离线记录',exact:true}).waitFor()
  console.log(name+': static hosting, root redirect, offline cold start and persistent capture passed (no Python API).')
 }finally{await browser.close()}
}}finally{await new Promise(r=>server.close(r))}
