import {afterEach,expect,it,vi} from 'vitest'
import {PocketDatabase} from '../lifeos/pocket/src/database'
import {initialize} from '../lifeos/pocket/src/repository'
import {recoverDesktopMedia} from '../lifeos/pocket/src/media-bridge'
import {mediaDigest} from '../lifeos/pocket/src/media'
import {CloudflareSyncTransport} from '../lifeos/pocket/src/sync/cloudflare'
import {AutoSyncController} from '../lifeos/pocket/src/sync/auto-controller'
import {newSyncIdentity,randomId} from '../lifeos/pocket/src/sync/identity'
const databases:PocketDatabase[]=[]
function database(){const db=new PocketDatabase('media-migration-'+randomId(8));databases.push(db);return db}
afterEach(async()=>{vi.unstubAllGlobals();vi.restoreAllMocks();for(const db of databases.splice(0))await db.delete()})
it('recovers desktop originals by historical filename, including non-audio, without editing business records',async()=>{
 vi.stubGlobal('location',{hostname:'127.0.0.1'})
 const db=database();await initialize(db);const before=await db.operations.count(),audio='a'.repeat(32)+'.m4a',pdf='b'.repeat(32)+'.pdf',missing='c'.repeat(32)+'.m4a',bytes=new Uint8Array([1,2,3,4])
 const fetcher=vi.fn(async(input:RequestInfo|URL)=>String(input).endsWith(missing)?new Response('',{status:404}):new Response(bytes))
 await recoverDesktopMedia(db,[audio,pdf,missing],fetcher as typeof fetch)
 expect((await db.media.get(audio))?.sha256).toBe(await mediaDigest(bytes));expect((await db.media.get(pdf))?.mime).toBe('application/pdf');expect(await db.media.get(missing)).toBeUndefined();expect(await db.operations.count()).toBe(before)
 fetcher.mockClear();await recoverDesktopMedia(db,[audio,pdf],fetcher as typeof fetch);expect(fetcher).not.toHaveBeenCalled()
})
it('does not try desktop file endpoints from a phone or import failed responses as files',async()=>{
 const db=database(),fetcher=vi.fn(async()=>new Response('failure',{status:500})),file='d'.repeat(32)+'.m4a'
 vi.stubGlobal('location',{hostname:'lifeos-pocket.pages.dev'});await recoverDesktopMedia(db,[file],fetcher as typeof fetch);expect(fetcher).not.toHaveBeenCalled()
 vi.stubGlobal('location',{hostname:'localhost'});await expect(recoverDesktopMedia(db,[file],fetcher as typeof fetch)).rejects.toThrow('不可读取');expect(await db.media.count()).toBe(0)
})
async function controllerFixture(){
 const db=database();await initialize(db);const transport=new CloudflareSyncTransport(await newSyncIdentity(randomId(),'Fixture')),controller=new AutoSyncController(db,()=>{}),calls:string[]=[]
 controller.transport=transport
 vi.spyOn(transport,'request').mockImplementation(async(action:string)=>{calls.push(action);return {} as any})
 vi.spyOn(transport,'status').mockImplementation(async()=>({head:0,mode:'staging',manifest:await transport.localManifest(db),archive:null,unarchived_batches:0,bytes:0,limit_bytes:768*1024*1024,devices:[]}))
 return {db,transport,controller,calls}
}
it('saves backup and sends preparation before a media-dependent sync; failures never claim verification',async()=>{
 const {controller,calls}=await controllerFixture();vi.spyOn(controller,'syncNow').mockImplementation(async()=>{calls.push('sync');throw Error('missing original')})
 await expect(controller.verifyMigration(true,async(_,stage)=>{calls.push('backup:'+stage)})).rejects.toThrow('missing original')
 expect(calls).toEqual(['backup:before','migration/prepare','sync'])
})
it('does not start contribution without consent or when saving the preflight backup fails',async()=>{
 const {controller,calls}=await controllerFixture(),sync=vi.spyOn(controller,'syncNow').mockResolvedValue()
 await expect(controller.verifyMigration(false,async()=>{})).rejects.toThrow('确认')
 await expect(controller.verifyMigration(true,async()=>{throw Error('backup failed')})).rejects.toThrow('backup failed')
 expect(calls).toEqual([]);expect(sync).not.toHaveBeenCalled()
})
it('saves a new complete backup after recovering media before marking the device verified',async()=>{
 const {db,controller,calls}=await controllerFixture(),file='e'.repeat(32)+'.wav',bytes=new Uint8Array([4,3,2,1]),backups:Record<string,unknown>[]=[]
 vi.spyOn(controller,'syncNow').mockImplementation(async()=>{calls.push('sync');await db.media.put({file,bytes:bytes.buffer,mime:'audio/wav',size:bytes.length,sha256:await mediaDigest(bytes),createdAt:'2026-11-17T10:00:00Z'})})
 await controller.verifyMigration(true,async(backup,stage)=>{backups.push(backup);calls.push('backup:'+stage)})
 expect(calls).toEqual(['backup:before','migration/prepare','sync','backup:verified','migration/verify']);expect(backups[0].media).toEqual([]);expect(backups[1].media).toHaveLength(1)
})
