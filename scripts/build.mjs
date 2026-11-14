import { build } from 'esbuild'
import { mkdir, readdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import {pushHandlers} from './sw-push.mjs'
const target='lifeos/static/pocket'
await mkdir(target,{recursive:true})
const {clientId:configuredClientId}=JSON.parse(await readFile('lifeos/pocket/google-client.json','utf8'))
const clientId=process.env.LIFEOS_GOOGLE_CLIENT_ID??configuredClientId
if(clientId&&!/^\d+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId))throw Error('Invalid public Google Web client ID')
await build({entryPoints:['lifeos/pocket/src/main.ts'],bundle:true,define:{__GOOGLE_CLIENT_ID__:JSON.stringify(clientId)},outfile:target+'/app.js',format:'esm',target:['safari17','chrome115','firefox115'],minify:true,legalComments:'none'})
for(const name of await readdir('lifeos/pocket/public'))await copyFile('lifeos/pocket/public/'+name,target+'/'+name)
// Geometric brand mark rendered locally. No image service or external font needed.
function crc(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let n=0;n<8;n++)c=(c&1)?0xedb88320^(c>>>1):c>>>1}return (c^0xffffffff)>>>0}
function chunk(type,data){const b=Buffer.from(type),n=Buffer.alloc(4),sum=Buffer.alloc(4);n.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([b,data])));return Buffer.concat([n,b,data,sum])}
for(const [name,size] of [['icon-192.png',192],['icon-512.png',512],['apple-touch-icon.png',180]]){
 const pixels=Buffer.alloc((size*4+1)*size)
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){const i=y*(size*4+1)+1+x*4,white=(x>=size*.35&&x<size*.45&&y>=size*.27&&y<size*.73)||(x>=size*.35&&x<size*.69&&y>=size*.64&&y<size*.73);pixels.set(white?[255,255,255,255]:[66,102,83,255],i)}
 const header=Buffer.alloc(13);header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=6
 await writeFile(target+'/'+name,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]))
}
const files=(await readdir(target)).filter(n=>n!=='sw.js').sort()
const hash=createHash('sha256');for(const name of files)hash.update(await readFile(target+'/'+name))
hash.update(await readFile(new URL(import.meta.url)))
hash.update(pushHandlers)
const cache='lifeos-pocket-'+hash.digest('hex').slice(0,16)
await writeFile(target+'/sw.js',`const CACHE=${JSON.stringify(cache)};const ASSETS=${JSON.stringify(files.map(f=>f==='index.html'?'/pocket/':'/pocket/'+f))};
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)))});
self.addEventListener('activate',event=>{event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith('lifeos-pocket-')&&key!==CACHE)await caches.delete(key);await self.clients.claim()})())});
self.addEventListener('message',event=>{if(event.data?.type==='SKIP_WAITING')self.skipWaiting()});
self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.method!=='GET'||url.origin!==self.location.origin||!url.pathname.startsWith('/pocket/'))return;if(event.request.mode==='navigate'){event.respondWith(caches.open(CACHE).then(cache=>cache.match('/pocket/')).then(cached=>cached||fetch(event.request)));return}if(ASSETS.includes(url.pathname))event.respondWith(caches.open(CACHE).then(cache=>cache.match(url.pathname)).then(cached=>cached||fetch(event.request)))});
${pushHandlers}
`)
console.log('Pocket built:',cache,'·',files.length,'pre-cached assets')
