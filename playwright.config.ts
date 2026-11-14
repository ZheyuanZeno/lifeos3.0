import { defineConfig } from '@playwright/test'
export default defineConfig({projects:[{name:'chromium',use:{browserName:'chromium'}},{name:'webkit',use:{browserName:'webkit'}}],testDir:'./tests/e2e',workers:1,fullyParallel:false,timeout:45000,expect:{timeout:10000},reporter:[['list']],use:{headless:true,viewport:{width:390,height:844},trace:'retain-on-failure',screenshot:'only-on-failure'}})
