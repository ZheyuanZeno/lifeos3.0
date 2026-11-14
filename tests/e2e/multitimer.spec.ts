import {test,expect} from './fixtures'
import {installTimerClock,advanceTimer} from './timer-fixture'

test('parallel project cards independently pause, annotate, stop and complete, including offline recovery',async({page,context})=>{
 await installTimerClock(page);await page.goto('/pocket/');await expect(page.locator('#offline-status')).toHaveText('离线资源已就绪');await expect(page.getByRole('heading',{name:'后台流程',exact:true})).toHaveCount(0)
 await page.getByRole('button',{name:'添加计划项目',exact:true}).click();await page.getByLabel('计划名称',{exact:true}).fill('洗衣服');await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.getByRole('dialog')).toBeHidden()
 await page.getByRole('button',{name:'开始 洗衣服',exact:true}).click();await page.getByRole('button',{name:'开始 学习',exact:true}).click();await page.getByRole('button',{name:'开始 做饭',exact:true}).click();await expect(page.locator('.active-timer')).toHaveCount(3)
 const laundry=page.locator('.active-timer').filter({hasText:'洗衣服'}),study=page.locator('.active-timer').filter({hasText:'学习'}),cook=page.locator('.active-timer').filter({hasText:'做饭'})
 await page.setViewportSize({width:320,height:740});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/parallel-timers-'+test.info().project.name+'.png',fullPage:true})
 await advanceTimer(page,40000);await study.getByRole('button',{name:'暂停计时',exact:true}).click();await expect(study.getByRole('button',{name:'继续计时',exact:true})).toBeVisible();await study.getByRole('button',{name:'编辑当前计时备注',exact:true}).click();await page.getByLabel('备注',{exact:true}).fill('第一章');await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.getByRole('dialog')).toBeHidden()
 const frozen=await study.locator('[data-active-elapsed]').textContent();await advanceTimer(page,60000);await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await expect(study.locator('[data-active-elapsed]')).toHaveText(frozen!);expect(await laundry.locator('[data-active-elapsed]').textContent()).not.toBe(frozen)
 await page.getByRole('checkbox',{name:'完成 洗衣服',exact:true}).click();await expect(page.locator('.active-timer')).toHaveCount(2);await expect(cook).toBeVisible();await expect(study).toContainText('第一章')
 await context.setOffline(true);await page.reload();await expect(page.locator('.active-timer')).toHaveCount(2);await expect(study.getByRole('button',{name:'继续计时',exact:true})).toBeVisible();await expect(study).toContainText('第一章')
 await cook.getByRole('button',{name:'结束计时',exact:true}).click();await expect(page.locator('.active-timer')).toHaveCount(1);await expect(study).toBeVisible();await study.getByRole('button',{name:'继续计时',exact:true}).click();await advanceTimer(page,40000);await study.getByRole('button',{name:'结束计时',exact:true}).click();await expect(page.locator('.active-timer')).toHaveCount(0);await expect(page.locator('.session-row')).toHaveCount(3)
 await page.setViewportSize({width:320,height:740});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
})

test('old background tasks display as ordinary plans and can time concurrently with a routine',async({page,request})=>{
 await page.goto('/pocket/');await page.getByRole('link',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'与本机白板交换',exact:true}).click();await expect(page.locator('#notice')).toHaveText('已与本机白板交换')
 const state=await(await request.get('/api/state')).json(),module=state.modules.find((m:{kind:string})=>m.kind==='plans')
 const flow={version:1,id:'old-flow',startedAt:'2026-11-14T10:00:00Z',steps:[{id:'wash',title:'洗涤',minutes:60,startedAt:'2026-11-14T10:01:00Z',expectedEndAt:'2026-11-14T11:01:00Z'}]}
 const response=await request.post('/api/save',{headers:{'X-LifeOS-Token':state.token},data:{record:{id:'old-laundry',module_id:module.id,type:'task',date:'2026-11-14',title:'旧洗衣计划',body:'已有备注',properties:{background_flow:JSON.stringify(flow)}}}});expect(response.ok()).toBe(true)
 await page.getByRole('button',{name:'与本机白板交换',exact:true}).click();await expect(page.getByRole('button',{name:'与本机白板交换',exact:true})).toBeEnabled();await page.getByRole('link',{name:'每日日程',exact:true}).click()
 const plan=page.locator('.plan-card').filter({hasText:'旧洗衣计划'});await expect(plan).toBeVisible();await plan.getByRole('button',{name:'开始 旧洗衣计划',exact:true}).click();await page.getByRole('button',{name:'开始 学习',exact:true}).click();await expect(page.locator('.active-timer')).toHaveCount(2);await expect(page.locator('.flow-card')).toHaveCount(0)
 await plan.getByRole('button',{name:'编辑计划 旧洗衣计划',exact:true}).click();await expect(page.getByLabel('备注',{exact:true})).toHaveValue('已有备注');await page.getByLabel('计划名称',{exact:true}).fill('洗衣服');await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.getByRole('dialog')).toBeHidden();await expect(page.getByRole('button',{name:'停止 洗衣服',exact:true})).toBeVisible()
})
