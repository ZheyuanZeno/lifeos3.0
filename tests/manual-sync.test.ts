import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import type {PocketDatabase} from '../lifeos/pocket/src/database'
import {sync,pendingCount} from '../lifeos/pocket/src/sync/engine'
import {DriveController} from '../lifeos/pocket/src/sync/controller'
import {GoogleDriveTransport} from '../lifeos/pocket/src/sync/google-drive'
vi.mock('../lifeos/pocket/src/sync/engine',()=>({sync:vi.fn(async()=>{}),pendingCount:vi.fn(async()=>0)}))
let controller:DriveController,doc:EventTarget&{visibilityState:string},win:EventTarget
beforeEach(()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});vi.mocked(sync).mockReset().mockResolvedValue(undefined);vi.mocked(pendingCount).mockResolvedValue(0)
 doc=Object.assign(new EventTarget(),{visibilityState:'visible'});win=new EventTarget();vi.stubGlobal('document',doc);vi.stubGlobal('window',win);vi.stubGlobal('navigator',{onLine:true})
 const db={local:{put:vi.fn(async()=>{})},cloudState:{get:async()=>undefined}} as unknown as PocketDatabase
 controller=new DriveController(db,()=>{});Object.assign(controller,{binding:{namespace:'client:account',clientId:'client',permissionId:'account',label:'test'}});controller.state.clientId='client';vi.spyOn(controller.authorization,'connected','get').mockReturnValue(true)
})
afterEach(()=>{controller.dispose();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks()})
it('only syncs explicitly; idle time, local changes, focus and network events never start cloud requests',async()=>{
 await controller.syncNow();expect(sync).toHaveBeenCalledTimes(1)
 await controller.refreshPending();await vi.advanceTimersByTimeAsync(60000)
 for(const name of ['focus','pageshow','online','offline'])win.dispatchEvent(new Event(name))
 for(const visibility of ['hidden','visible']){doc.visibilityState=visibility;doc.dispatchEvent(new Event('visibilitychange'))}
 await vi.advanceTimersByTimeAsync(60000);expect(sync).toHaveBeenCalledTimes(1);expect(controller.state.syncing).toBe(false)
 await controller.syncNow();expect(sync).toHaveBeenCalledTimes(2)
})
it('connecting authorizes the account without uploading or downloading business records',async()=>{
 vi.spyOn(controller.authorization,'authorize').mockResolvedValue(undefined);vi.spyOn(GoogleDriveTransport,'account').mockResolvedValue({id:'account',label:'test'})
 await controller.connect();await vi.advanceTimersByTimeAsync(60000);expect(controller.accountId).toBe('account');expect(controller.status).toBe('已连接，等待手动同步');expect(sync).not.toHaveBeenCalled()
 await controller.syncNow();expect(sync).toHaveBeenCalledTimes(1)
})
it('deduplicates repeated manual clicks without scheduling a follow-up request',async()=>{
 let release!:()=>void;vi.mocked(sync).mockImplementationOnce(()=>new Promise<void>(resolve=>release=resolve));const first=controller.syncNow();const second=controller.syncNow();expect(second).toBe(first);expect(sync).toHaveBeenCalledTimes(1)
 await controller.refreshPending();release();await first;await vi.advanceTimersByTimeAsync(60000);expect(sync).toHaveBeenCalledTimes(1)
})
it('reports failures without automatic retries, and expired tokens never open a login popup',async()=>{
 vi.mocked(sync).mockRejectedValueOnce(Error('temporary network failure'));await expect(controller.syncNow()).rejects.toThrow('temporary');await vi.advanceTimersByTimeAsync(60000);expect(sync).toHaveBeenCalledTimes(1)
 await controller.syncNow();expect(sync).toHaveBeenCalledTimes(2)
 const authorize=vi.spyOn(controller.authorization,'authorize');vi.spyOn(controller.authorization,'connected','get').mockReturnValue(false);win.dispatchEvent(new Event('focus'));await controller.syncNow();expect(sync).toHaveBeenCalledTimes(2);expect(authorize).not.toHaveBeenCalled();expect(controller.state.connected).toBe(false)
})
it('does not use the previous account while another authorization is running',async()=>{
 controller.state.connecting=true;await expect(controller.syncNow()).rejects.toThrow('授权');win.dispatchEvent(new Event('focus'));await vi.advanceTimersByTimeAsync(60000);expect(sync).not.toHaveBeenCalled();controller.state.connecting=false;await controller.syncNow();expect(sync).toHaveBeenCalledTimes(1)
})
