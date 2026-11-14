import type {Page} from '@playwright/test'
// Keep the test-only wall-clock offset across reloads without waiting in real time.
function timerClock(){if(Reflect.get(window,'__lifeosTestClock'))return;const now=Date.now;Date.now=()=>now()+Number(sessionStorage.getItem('lifeos.test.clock')??0);Reflect.set(window,'__lifeosTestClock',true)}
export async function installTimerClock(page:Page){await page.addInitScript(timerClock)}
export async function advanceTimer(page:Page,ms=31001){await page.evaluate(timerClock);await page.evaluate(ms=>sessionStorage.setItem('lifeos.test.clock',String(Number(sessionStorage.getItem('lifeos.test.clock')??0)+ms)),ms)}
