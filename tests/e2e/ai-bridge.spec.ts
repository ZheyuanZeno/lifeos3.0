import {test,expect} from './fixtures'
import {GoogleAPI} from './google-fixture'
const command={protocol:'lifeos-ai-v1',command_id:'e2e-import',created_at:'2026-11-14T10:00:00Z',source:{provider:'canvas',reference:'mock-only'},operations:[{action:'create_plan',data:{title:'Canvas 导入测试',date:'2026-12-03',deadline:'2026-12-03',source_id:'canvas:mock:assignment'}}]}
test('offline JSON review creates a real plan, replay skips, and independent timers survive',async({page,context})=>{
 await page.goto('/pocket/');await expect(page.locator('#offline-status')).toHaveText('离线资源已就绪');await page.reload();await context.setOffline(true)
 await page.getByRole('button',{name:'开始 学习',exact:true}).click();await page.getByRole('button',{name:'开始 做饭',exact:true}).click();await expect(page.locator('.active-timer')).toHaveCount(2)
 await page.getByRole('link',{name:'设置',exact:true}).click();const ai=page.locator('#ai-root');await expect(ai.getByRole('heading',{name:'AI 集成',exact:true})).toBeVisible()
 await ai.locator('input[type=file]').setInputFiles({name:'command.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(command))});await expect(ai).toContainText('待审核 1');await expect(ai).toContainText('Canvas 导入测试')
 await page.setViewportSize({width:320,height:740});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/ai-review-'+test.info().project.name+'.png',fullPage:true})
 await page.getByRole('link',{name:'每日日程',exact:true}).click();await expect(page.locator('.plan-card')).toHaveCount(0);await page.getByRole('link',{name:'设置',exact:true}).click()
 await ai.getByRole('button',{name:'确认执行此命令（1 项）',exact:true}).click();await expect(ai).toContainText('命令已保存到本机');await page.getByRole('link',{name:'每日日程',exact:true}).click();await expect(page.locator('.plan-card')).toHaveCount(1);await expect(page.locator('.plan-card')).toContainText('KTH Canvas');await expect(page.locator('.active-timer')).toHaveCount(2)
 await page.getByRole('link',{name:'设置',exact:true}).click();await ai.locator('input[type=file]').setInputFiles({name:'command.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(command))});await expect(ai).toContainText('此命令已处理');await page.reload();await page.getByRole('link',{name:'每日日程',exact:true}).click();await expect(page.locator('.plan-card')).toHaveCount(1)
})

test.describe('Google Docs API mock',()=>{
test.use({serviceWorkers:'block'})
test('mock Google Docs creates private files with separate drive.file consent, previews Inbox and atomically writes Context',async({page,context})=>{
 const google=new GoogleAPI();await google.attach(context);let id=0,contextText='',account='mock-account';const requests:unknown[]=[]
 await context.route('https://www.googleapis.com/drive/v3/about**',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({user:{permissionId:account}})}))
 await context.route('https://www.googleapis.com/drive/v3/files?fields=id',route=>{const data=route.request().postDataJSON();expect(data.mimeType).toBe('application/vnd.google-apps.document');expect(data.permissions).toBeUndefined();return route.fulfill({contentType:'application/json',body:JSON.stringify({id:++id===1?'inbox':'context'})})})
 await context.route('https://docs.googleapis.com/**',route=>{const request=route.request();if(request.method()==='POST'){const data=request.postDataJSON();requests.push(data);expect(data.writeControl.requiredRevisionId).toBe('rev');contextText=data.requests.at(-1).insertText.text;return route.fulfill({contentType:'application/json',body:'{}'})}const text=request.url().includes('/inbox?')?'LIFEOS_CMD_V1_BEGIN\n'+JSON.stringify(command)+'\nLIFEOS_CMD_V1_END\n':contextText;return route.fulfill({contentType:'application/json',body:JSON.stringify({revisionId:'rev',body:{content:[{endIndex:text.length+2,paragraph:{elements:[{textRun:{content:text+'\n'}}]}}]}})})})
 await page.goto('/pocket/#settings');const ai=page.locator('#ai-root');await ai.getByRole('button',{name:'准备 AI 授权',exact:true}).click();await ai.getByRole('button',{name:'连接 AI 文档',exact:true}).click();await expect(ai).toContainText('AI 文档授权成功');expect(await page.evaluate(()=>Reflect.get(window,'__requestedScopes'))).toBe('https://www.googleapis.com/auth/drive.file')
 await ai.getByRole('button',{name:'创建双文档',exact:true}).click();await expect(ai).toContainText('双文档已创建');await ai.getByRole('button',{name:'检查 AI 更新',exact:true}).click();await expect(ai).toContainText('待审核 1');await ai.getByRole('button',{name:'确认执行此命令（1 项）',exact:true}).click();await expect(ai).toContainText('命令已保存到本机')
 await ai.locator('summary').filter({hasText:'生成 AI 上下文'}).click();await ai.getByRole('button',{name:'生成并覆盖 Context',exact:true}).click();await expect(ai).toContainText('Context 已原子更新并回读校验');expect(JSON.parse(contextText).records).toHaveLength(1);expect(requests).toHaveLength(1)
 await ai.getByRole('button',{name:'断开 AI 绑定',exact:true}).click();await expect(ai).toContainText('已断开本机 AI 绑定');await ai.getByRole('button',{name:'连接 AI 文档',exact:true}).click();await expect(ai).toContainText('AI 文档授权成功');await ai.locator('summary').filter({hasText:'其他设备绑定已有文档'}).click();await ai.getByLabel('Inbox 文档链接',{exact:true}).fill('inbox');await ai.getByLabel('Context 文档链接',{exact:true}).fill('context');await ai.getByRole('button',{name:'绑定已有双文档',exact:true}).click();await expect(ai).toContainText('已有双文档已绑定');expect(id).toBe(2)
 account='another-account';await ai.getByRole('button',{name:'检查 AI 更新',exact:true}).click();await expect(ai).toContainText('Google 账号与绑定不一致');google.release()
})

})
