import {test,expect} from './fixtures'
import {advanceTimer} from './timer-fixture'
test('short stops leave no history, other tasks remain available, and edit controls use borderless top-right ellipses',async({page})=>{
 await page.goto('/pocket/');await expect(page.locator('.routine-card')).toHaveCount(7)
 await expect(page.locator('.timer-state')).toHaveCount(0);await expect(page.locator('.routine-card .edit-button')).toHaveCount(7);await expect(page.locator('.edit-button').first().locator('svg circle')).toHaveCount(3)
 const edit=page.getByRole('button',{name:'编辑 做饭',exact:true});expect(await edit.evaluate(b=>getComputedStyle(b).borderWidth)).toBe('0px');expect(await edit.evaluate(b=>getComputedStyle(b).borderRadius)).toBe('0px')
 await page.getByRole('button',{name:'开始 做饭',exact:true}).click();await expect(page.locator('.session-row')).toHaveCount(0);await expect(page.getByRole('button',{name:'开始 学习',exact:true})).toBeEnabled();await expect(page.getByRole('button',{name:'停止 做饭',exact:true})).toBeEnabled()
 expect(await page.locator('.is-running').evaluate(b=>getComputedStyle(b).boxShadow)).toBe('none');expect(await page.locator('.is-running').evaluate(b=>getComputedStyle(b).borderColor)).toBe(await page.locator('.routine-card:not(.is-running)').first().evaluate(b=>getComputedStyle(b).borderColor))
 await page.getByRole('button',{name:'停止 做饭',exact:true}).click();await expect(page.locator('.session-row')).toHaveCount(0);await expect(page.locator('[data-day-total]')).toHaveText('共 00:00:00');await expect(page.getByRole('button',{name:'开始 学习',exact:true})).toBeEnabled()
 await page.getByRole('button',{name:'开始 学习',exact:true}).click();await advanceTimer(page);await page.getByRole('button',{name:'停止 学习',exact:true}).click();await expect(page.locator('.session-row')).toHaveCount(1);await expect(page.locator('.session-info h3')).toHaveText('学习');await expect(page.getByRole('button',{name:'编辑 学习 的计时',exact:true}).locator('svg circle')).toHaveCount(3)
 await page.getByRole('link',{name:'随手记',exact:true}).click();await page.getByLabel('此刻的想法').fill('圆形编辑入口');await page.getByRole('button',{name:'保存随手记',exact:true}).click();await expect(page.getByRole('button',{name:'编辑随手记 圆形编辑入口',exact:true}).locator('svg circle')).toHaveCount(3)
 await page.getByRole('link',{name:'每日日程',exact:true}).click();await page.screenshot({path:'test-results/timer-rules-'+test.info().project.name+'.png'})
})
