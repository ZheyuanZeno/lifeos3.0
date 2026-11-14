import {Miniflare} from 'miniflare'
import {build} from 'esbuild'
import webpush from 'web-push'
import {createECDH,randomBytes} from 'node:crypto'
import ece from 'http_ece'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve,sep} from 'node:path'

const root=resolve(process.env.LIFEOS_TEST_TMP??tmpdir()),dir=await mkdtemp(join(root,'lifeos-notify-'))
const vapid=webpush.generateVAPIDKeys(),browser=createECDH('prime256v1');browser.generateKeys()
const auth=randomBytes(16).toString('base64url'),received=[]
const sub={endpoint:'https://web.push.apple.com/test-device',keys:{p256dh:browser.getPublicKey().toString('base64url'),auth}}
const bundled=await build({entryPoints:['workers/notify/src/index.ts'],bundle:true,write:false,platform:'node',format:'esm',target:'es2023',external:['node:*'],banner:{js:"import {createRequire} from 'node:module';const require=createRequire('/notify-test-worker.mjs');"}})
const mf=new Miniflare({name:'notify-test',modules:true,scriptPath:resolve('notify-test-worker.mjs'),script:process.env.LIFEOS_NOTIFY_BUNDLE?await readFile(process.env.LIFEOS_NOTIFY_BUNDLE,'utf8'):bundled.outputFiles[0].text,compatibilityDate:'2026-08-01',compatibilityFlags:['nodejs_compat'],durableObjects:{REMINDERS:{className:'ReminderHub',useSQLite:true}},durableObjectsPersist:dir,bindings:{VAPID_PUBLIC_KEY:vapid.publicKey,VAPID_PRIVATE_KEY:vapid.privateKey,DEVICE_AUTH_SECRET:randomBytes(32).toString('hex')},outboundService:async request=>{
 const url=new URL(request.url)
 if(url.hostname==='www.googleapis.com')return Response.json({user:{permissionId:request.headers.get('Authorization')==='Bearer google-two'?'account-two':'account-one'}})
 if(url.hostname==='web.push.apple.com'){
  assert.equal(request.headers.get('Content-Encoding'),'aes128gcm');assert.match(request.headers.get('Authorization'),/^vapid /)
  const encrypted=Buffer.from(await request.arrayBuffer()),payload=JSON.parse(ece.decrypt(encrypted,{version:'aes128gcm',privateKey:browser,authSecret:auth}).toString())
  received.push(payload);return new Response(null,{status:201})
 }
 throw Error('Unexpected outbound service '+url.hostname)
}})
async function call(path,method='GET',token='',data){const response=await mf.dispatchFetch('https://notify.test/'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});return {status:response.status,body:await response.json()}}
const pause=ms=>new Promise(r=>setTimeout(r,ms))
async function until(check){for(let i=0;i<60;i++){if(check())return;await pause(200)}assert.ok(check(),'background alarm did not deliver')}
const op=(id,patch,{device='a',sequence=1,clock=1,context={},record='task'}={})=>({id,deviceId:device,sequence,clock,context,entity:'records',recordId:record,patch,timestamp:new Date().toISOString(),uploaded:0})
const plan=(id,at,record='task')=>op(id,{type:'task',title:'计划 '+record,status:'todo',deleted:false,module_id:'plans',properties:{planned_start:new Date(at).toISOString()}},{record})
try{
 assert.equal((await call('config')).body.ready,true)
 const enrollment=await call('enroll','POST','google-one',{deviceId:'phone-a'});assert.equal(enrollment.status,200)
 const a=enrollment.body.token,b=(await call('enroll','POST','google-one',{deviceId:'phone-b'})).body.token,c=(await call('enroll','POST','google-two',{deviceId:'phone-c'})).body.token
 assert.equal((await call('state','PUT',a+'x',{operations:[]})).status,401)
 assert.equal((await call('subscription','PUT',a,{subscription:sub})).status,200)
 assert.equal((await call('subscription','PUT',b,{subscription:{...sub,endpoint:'https://localhost/ssrf'}})).status,400)
 // No page is running. The actual workerd alarm creates encrypted Web Push.
 const first=plan('first',Date.now()+1500)
 assert.equal((await call('state','PUT',a,{operations:[first]})).status,200)
 assert.equal((await call('state','PUT',a,{operations:[first]})).status,200)
 assert.equal((await call('state','PUT',a,{operations:[{...first,patch:{...first.patch,title:'divergent'}}]})).status,409)
 await until(()=>received.some(p=>p.id==='task'));assert.equal(received.filter(p=>p.id==='task').length,1)
 const scheduled=plan('later',Date.now()+2500,'cancelled'),done=op('done',{status:'done'},{device:'b',clock:3,context:{a:1},record:'cancelled'})
 assert.equal((await call('state','PUT',a,{operations:[scheduled]})).status,200)
 assert.equal((await call('state','PUT',b,{operations:[done]})).status,200)
 assert.equal((await call('state','PUT',a,{operations:[scheduled]})).status,200)
 // Same record ID in a different account is isolated.
 assert.equal((await call('status','GET',c)).body.scheduled,0)
 await pause(3200);assert.equal(received.filter(p=>p.id==='cancelled').length,0)
 // A changed minute supersedes the original alarm, with one visible delivery.
 const moving=plan('moving',Date.now()+1700,'moved'),changed=op('moving2',{properties:{planned_start:new Date(Date.now()+3600).toISOString()}},{sequence:2,clock:2,context:{a:1},record:'moved'})
 await call('state','PUT',a,{operations:[moving,changed]});await pause(2100);assert.equal(received.filter(p=>p.id==='moved').length,0);await until(()=>received.some(p=>p.id==='moved'));assert.equal(received.filter(p=>p.id==='moved').length,1)
 assert.equal((await call('test','POST',a,{})).status,200);assert.equal((await call('test','POST',a,{})).status,429)
 assert.equal((await call('subscription','DELETE',a,{})).status,200);assert.equal((await call('status','GET',a)).body.subscribed,false)
 await call('device','DELETE',a,{});assert.equal((await call('state','PUT',a,{operations:[]})).status,401)
 console.log('PASS real Workers SQLite alarms, encrypted Web Push decrypt, dedupe, causal cross-device cancel, reschedule, account isolation, auth revocation, SSRF validation and test throttle')
}finally{await mf.dispose();const target=resolve(dir);assert.ok(target.startsWith(root+sep)&&target.split(sep).at(-1).startsWith('lifeos-notify-'));await rm(target,{recursive:true,force:true})}
