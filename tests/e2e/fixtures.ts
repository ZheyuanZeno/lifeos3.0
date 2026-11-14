import { test as base,expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { mkdtemp,rm } from 'node:fs/promises'
import { resolve,join,sep } from 'node:path'
import { tmpdir } from 'node:os'
async function browserPort(){
 for(let attempt=0;attempt<20;attempt++){
  const probe=createServer()
  try{await new Promise<void>((r,j)=>{probe.once('error',j);probe.listen(20000+Math.floor(Math.random()*40000),'127.0.0.1',r)});const address=probe.address();if(!address||typeof address==='string')throw Error('Unable to allocate test port');const port=address.port;await new Promise<void>((r,j)=>probe.close(e=>e?j(e):r()));return port}
  catch(e){if(!['EADDRINUSE','EACCES'].includes((e as NodeJS.ErrnoException).code??''))throw e}
 }
 throw Error('No free browser-safe test port')
}
export const test=base.extend({baseURL:async({},use)=>{
 const port=await browserPort()
 const tmpRoot=resolve(process.env.LIFEOS_TEST_TMP??tmpdir()),dataDir=await mkdtemp(join(tmpRoot,'lifeos-e2e-'))
 const child=spawn('python',['-u','lifeos/app.py','--port',String(port),'--data-dir',dataDir,'--no-browser'],{cwd:process.cwd(),env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']})
 let output=''
 try{
  await new Promise<void>((resolveReady,reject)=>{const timeout=setTimeout(()=>reject(Error('Server startup timed out: '+output)),15000);child.once('error',e=>{clearTimeout(timeout);reject(e)});child.once('exit',code=>{clearTimeout(timeout);reject(Error('Server exited '+code+': '+output))});child.stderr.on('data',b=>output+=b.toString());child.stdout.on('data',b=>{output+=b.toString();if(output.includes('http://127.0.0.1:'+port)){clearTimeout(timeout);resolveReady()}})})
  await use('http://127.0.0.1:'+port)
 }finally{
  if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited}
  const target=resolve(dataDir);if(!target.startsWith(tmpRoot+sep)||!target.split(sep).at(-1)!.startsWith('lifeos-e2e-'))throw Error('Unexpected temporary test directory')
  await rm(target,{recursive:true,force:true})
 }
}})
export {expect}
