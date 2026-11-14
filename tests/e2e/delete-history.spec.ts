import {test,expect} from './fixtures'
import type {Page} from '@playwright/test'
import {advanceTimer} from './timer-fixture'
async function boot(page:Page){await page.goto('/pocket/');await expect(page.locator('.daily-toolbar')).toBeVisible()}
async function footer(page:Page){const dialog=page.getByRole('dialog'),buttons=dialog.locator('.form-actions button');await expect(buttons).toHaveText(['删除','保存']);await expect(dialog.getByRole('button',{name:'取消',exact:true})).toHaveCount(0);const left=await buttons.nth(0).boundingBox(),right=await buttons.nth(1).boundingBox();expect(left!.x+left!.width).toBeLessThanOrEqual(right!.x);expect(right!.x-left!.x-left!.width).toBeLessThanOrEqual(12)}
async function remove(page:Page){page.once('dialog',dialog=>dialog.accept());await page.getByRole('dialog').getByRole('button',{name:'删除',exact:true}).click();await expect(page.getByRole('dialog')).toBeHidden()}
async function exchange(page:Page){await page.getByRole('link',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'与本机白板交换',exact:true}).click();await expect(page.locator('#notice')).toHaveText('已与本机白板交换')}

test('daily interval deletion removes only the chosen history and its duration and survives refresh/exchange',async({page,request})=>{
 await boot(page);await expect(page.locator('.routine-symbol')).toHaveCount(0);await expect(page.locator('.page-intro,.hint,.eyebrow')).toHaveCount(0);await expect(page.locator('h1:not(.visually-hidden)')).toHaveCount(0)
 await page.getByRole('button',{name:'开始 做饭',exact:true}).click();await advanceTimer(page);await page.getByRole('button',{name:'停止 做饭',exact:true}).click();await page.getByRole('button',{name:'编辑 做饭 的计时',exact:true}).click();await footer(page)
 const day=(await page.getByLabel('开始时间').inputValue()).slice(0,10);await page.getByLabel('开始时间').fill(day+'T08:00:00');await page.getByLabel('结束时间').fill(day+'T08:25:00');await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.locator('[data-day-total]')).toHaveText('共 00:25:00')
 const id=await page.locator('.session-end strong').getAttribute('data-session-duration');await page.getByRole('button',{name:'开始 学习',exact:true}).click();await advanceTimer(page);await page.getByRole('button',{name:'停止 学习',exact:true}).click();await expect(page.locator('.session-row')).toHaveCount(2)
 await page.getByRole('button',{name:'编辑 做饭 的计时',exact:true}).click();await footer(page);await page.screenshot({path:'test-results/session-delete-'+test.info().project.name+'.png'});await page.getByLabel('开始时间').fill('');await remove(page)
 await expect(page.locator('.session-row')).toHaveCount(1);await expect(page.locator('.session-info h3')).toHaveText('学习');await expect(page.locator('[data-day-total]')).not.toContainText('00:25:')
 await exchange(page);const state=await(await request.get('/api/state')).json(),result=await(await request.post('/api/pocket/exchange',{headers:{'X-LifeOS-Token':state.token},data:{protocol:1,operations:[]}})).json();expect(result.operations.some((o:{entity:string;recordId:string;patch:{deleted?:boolean}})=>o.entity==='sessions'&&o.recordId===id&&o.patch.deleted===true)).toBe(true)
 await page.goto('/pocket/');await expect(page.locator('.session-row')).toHaveCount(1);await expect(page.locator('.session-info h3')).toHaveText('学习');await expect(page.locator('.routine-card')).toHaveCount(7)
})

test('note deletion shares the footer, does not require valid draft fields, and reaches SQLite',async({page,request})=>{
 await boot(page);await page.getByRole('link',{name:'随手记',exact:true}).click();await expect(page.locator('.page-intro,.recording-hint,.eyebrow')).toHaveCount(0)
 for(const title of ['删除这一条','保留这一条']){await page.getByLabel('此刻的想法').fill(title);await page.getByRole('button',{name:'保存随手记',exact:true}).click();await expect(page.getByRole('button',{name:title,exact:true})).toBeVisible()}
 await page.getByRole('button',{name:'编辑随手记 删除这一条',exact:true}).click();await footer(page);await page.screenshot({path:'test-results/note-delete-'+test.info().project.name+'.png'});await page.getByLabel('标题',{exact:true}).fill('');await remove(page);await expect(page.locator('.note-card')).toHaveCount(1);await expect(page.getByRole('button',{name:'保留这一条',exact:true})).toBeVisible()
 await exchange(page);const records=(await(await request.get('/api/state')).json()).records;expect(records.find((r:{title:string})=>r.title==='删除这一条').deleted).toBe(true);expect(records.find((r:{title:string})=>r.title==='保留这一条').deleted).toBe(false)
 await page.goto('/pocket/#capture');await expect(page.locator('.note-card')).toHaveCount(1);await expect(page.getByRole('button',{name:'保留这一条',exact:true})).toBeVisible();await page.getByRole('link',{name:'设置',exact:true}).click();await expect(page.locator('.page-intro,.eyebrow')).toHaveCount(0)
})
