import {test,expect} from './fixtures'
import {GoogleAPI} from './google-fixture'
import {advanceTimer,installTimerClock} from './timer-fixture'
test.use({serviceWorkers:'block'})
test('daily history is opt-in and projects stopped timer time and remarks without media or operations',async({page,context})=>{
 const google=new GoogleAPI();await google.attach(context);await installTimerClock(page)
 let historyAllowed=false,projection:any
 await context.route('**/api/mcp-device/**',async route=>{
  const action=new URL(route.request().url()).pathname.split('/').at(-1),body=route.request().postDataJSON();let response:unknown={}
  if(action==='enroll'){historyAllowed=body.policy.daily;response={token:'test-device',accountId:'mock-account'}}
  if(action==='pair')response={secret:'test-pair'}
  if(action==='projection')projection=body
  if(action==='pending')response={commands:[],recent:[]}
  await route.fulfill({contentType:'application/json',body:JSON.stringify(response)})
 })
 await page.goto('/pocket/');await page.getByRole('button',{name:'开始 学习',exact:true}).click();await advanceTimer(page,65000);await page.getByRole('button',{name:'停止 学习',exact:true}).click();await expect(page.locator('.session-row')).toHaveCount(1)
 await page.getByRole('link',{name:'设置',exact:true}).click();await expect(page.getByRole('button',{name:'连接 Google Drive',exact:true})).toBeEnabled();await page.getByRole('button',{name:'连接 Google Drive',exact:true}).click();await expect(page.getByRole('button',{name:'立即同步',exact:true})).toBeEnabled()
 await page.getByRole('button',{name:'绑定设备并生成配对码',exact:true}).click();await expect.poll(()=>projection!==undefined).toBe(true);expect(historyAllowed).toBe(false);expect(projection.daily_rows).toEqual([])
 projection=undefined;await page.getByRole('checkbox',{name:'允许 AI 读取当日记录（计时及备注）',exact:true}).check();await page.getByRole('button',{name:'绑定设备并生成配对码',exact:true}).click();await expect.poll(()=>projection?.daily_rows?.length).toBe(1)
 expect(historyAllowed).toBe(true);expect(projection.daily_rows[0]).toMatchObject({title:'学习',subject_kind:'routine',note:''});expect(projection.daily_rows[0].duration_ms).toBeGreaterThan(30000);expect(projection.daily_rows[0].ended_at).toBeTruthy();expect(projection.daily_rows[0]).not.toHaveProperty('pauses');expect(projection.daily_rows[0]).not.toHaveProperty('attachments');expect(projection).not.toHaveProperty('operations');expect(google.requests.filter(r=>r.path.includes('/upload/'))).toHaveLength(0);google.release()
})
