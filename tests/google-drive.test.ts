import { describe,expect,it,vi } from 'vitest'
import { GoogleDriveTransport } from '../lifeos/pocket/src/sync/google-drive'
import { BATCH_KIND,SyncError } from '../lifeos/pocket/src/sync/types'
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}})
const properties={lifeosKind:BATCH_KIND,batchId:'batch',sha256:'a'.repeat(64)}
describe('Google Drive API adapter',()=>{
 it('allocates stable IDs in appDataFolder using only a bearer header',async()=>{
  const fetcher=vi.fn(async()=>response({ids:['preallocated']})),transport=new GoogleDriveTransport('account',()=> 'private-test-token',()=>{},fetcher)
  expect(await transport.allocateFileId()).toBe('preallocated');const [url,options]=fetcher.mock.calls[0] as unknown as [string,RequestInit]
  expect(url).toContain('space=appDataFolder');expect(url).not.toContain('private-test-token');expect(options.headers).toMatchObject({Authorization:'Bearer private-test-token'})
 })
 it('accepts omitted empty lists and preserves the final changes token',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(response({})).mockResolvedValueOnce(response({newStartPageToken:'new-cursor'})),transport=new GoogleDriveTransport('a',()=> 'token',()=>{},fetcher)
  expect((await transport.listAll()).files).toEqual([]);expect(await transport.listChanges('old-cursor')).toEqual({files:[],removedIds:[],nextPageToken:undefined,cursor:'new-cursor'})
 })
 it('filters unrelated app files and follows explicit pagination tokens',async()=>{
  const fetcher=vi.fn(async()=>response({nextPageToken:'next',files:[{id:'ours',version:'2',appProperties:properties},{id:'unrelated',version:'1'}]})),transport=new GoogleDriveTransport('a',()=> 'token',()=>{},fetcher)
  const page=await transport.listAll('page-one');expect(page.files).toEqual([{id:'ours',batchId:'batch',digest:'a'.repeat(64),version:'2'}]);expect(page.nextPageToken).toBe('next');expect((fetcher.mock.calls[0] as unknown as [string,RequestInit])[0]).toContain('pageToken=page-one')
 })
 it('uses multipart creation with the preallocated ID and immutable batch metadata',async()=>{
  const fetcher=vi.fn(async()=>response({id:'allocated'})),transport=new GoogleDriveTransport('a',()=> 'token',()=>{},fetcher)
  await transport.createFile('allocated',new TextEncoder().encode('{"内容":"保留原文"}'),'batch','a'.repeat(64))
  const [url,options]=fetcher.mock.calls[0] as unknown as [string,RequestInit];expect(url).toContain('/upload/drive/v3/files?uploadType=multipart');expect(options.method).toBe('POST');const body=String(options.body);expect(body).toContain('"id":"allocated"');expect(body).toContain('"parents":["appDataFolder"]');expect(body).toContain('保留原文');expect(body).toContain('Content-Type: application/json\r\n')
 })
 it('allows retry verification after create returns 409 and treats missing reads as absent',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(response({},409)).mockResolvedValueOnce(response({},404)),transport=new GoogleDriveTransport('a',()=> 'token',()=>{},fetcher)
  await transport.createFile('same',new Uint8Array([1]),'batch','a'.repeat(64));expect(await transport.readFile('same')).toBeNull()
 })
 it('invalidates expired tokens without retrying or storing credentials',async()=>{
  const invalidate=vi.fn(),fetcher=vi.fn(async()=>response({},401)),delay=vi.fn(async()=>{}),transport=new GoogleDriveTransport('a',()=> 'expired-secret',invalidate,fetcher,delay)
  await expect(transport.startCursor()).rejects.toMatchObject({code:'auth'});expect(invalidate).toHaveBeenCalledOnce();expect(fetcher).toHaveBeenCalledOnce();expect(delay).not.toHaveBeenCalled()
 })
 it('uses bounded backoff for rate limits, and reports permission failures separately',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(response({},429)).mockResolvedValueOnce(response({},503)).mockResolvedValueOnce(response({startPageToken:'ok'})),delay=vi.fn(async()=>{}),transport=new GoogleDriveTransport('a',()=> 'token',()=>{},fetcher,delay)
  expect(await transport.startCursor()).toBe('ok');expect(delay.mock.calls).toEqual([[300],[600]])
  const forbidden=new GoogleDriveTransport('a',()=> 'token',()=>{},async()=>response({},403));await expect(forbidden.startCursor()).rejects.toMatchObject({code:'permission'})
 })
 it('does not send a request if the in-memory authorization has expired',async()=>{
  const fetcher=vi.fn(),transport=new GoogleDriveTransport('a',()=>{throw new SyncError('expired','auth')},()=>{},fetcher)
  await expect(transport.startCursor()).rejects.toMatchObject({code:'auth'});expect(fetcher).not.toHaveBeenCalled()
 })
 it('reads the stable Google account identity without adding email or profile OAuth scopes',async()=>{
  const fetcher=vi.fn(async()=>response({user:{permissionId:'permission-id',emailAddress:'test@example.invalid'}}))
  expect(await GoogleDriveTransport.account(()=> 'token',()=>{},fetcher)).toEqual({id:'permission-id',label:'test@example.invalid'});expect((fetcher.mock.calls[0] as unknown as [string,RequestInit])[0]).toContain('/drive/v3/about?fields=')
 })
})
