import {test,expect} from './fixtures'
import {GoogleAPI} from './google-fixture'
test.use({serviceWorkers:'block'})

test('quick notes publish their body only after explicit note access is saved',async({page,context})=>{
 const google=new GoogleAPI();await google.attach(context)
 let noteAccess=false,received:Record<string,unknown>[]|undefined
 await context.route('**/api/mcp-device/**',async route=>{
  const action=new URL(route.request().url()).pathname.split('/').at(-1),body=route.request().postDataJSON();let response:unknown={}
  if(action==='enroll'){noteAccess=body.policy.notes;response={token:'test-device-credential',accountId:'mock-account'}}
  if(action==='pair')response={secret:'test-pair'}
  if(action==='projection')received=body.rows
  if(action==='pending')response={commands:[],recent:[]}
  await route.fulfill({contentType:'application/json',body:JSON.stringify(response)})
 })
 await page.goto('/pocket/');await page.getByRole('link',{name:'随手记',exact:true}).click();await page.getByLabel('此刻的想法').fill('随手记授权测试\n只有授权后可读的正文');await page.getByRole('button',{name:'保存随手记',exact:true}).click();await page.getByRole('button',{name:'随手记授权测试',exact:true}).waitFor()
 await page.getByRole('link',{name:'设置',exact:true}).click();await expect(page.getByRole('button',{name:'连接 Google Drive',exact:true})).toBeEnabled();await page.getByRole('button',{name:'连接 Google Drive',exact:true}).click();await expect(page.getByRole('button',{name:'立即同步',exact:true})).toBeEnabled()
 await page.getByRole('button',{name:'绑定设备并生成配对码',exact:true}).click();await expect.poll(()=>received!==undefined).toBe(true);expect(noteAccess).toBe(false);expect(received!.some(r=>r.type==='note')).toBe(false)
 received=undefined;await page.getByRole('checkbox',{name:'允许 AI 读取和管理随手记（含正文）',exact:true}).check();await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await expect(page.getByRole('checkbox',{name:'允许 AI 读取和管理随手记（含正文）',exact:true})).toBeChecked();await page.getByRole('button',{name:'绑定设备并生成配对码',exact:true}).click()
 await expect.poll(()=>received?.some(r=>r.type==='note')).toBe(true);expect(noteAccess).toBe(true);expect(received!.find(r=>r.type==='note')?.body).toBe('随手记授权测试\n只有授权后可读的正文');expect(received!.every(r=>!('attachments'in r))).toBe(true);expect(google.requests.filter(r=>r.path.includes('/upload/'))).toHaveLength(0);google.release()
})
