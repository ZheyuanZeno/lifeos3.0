import { afterEach,describe,expect,it,vi } from 'vitest'
import { GoogleAuthorization,DRIVE_SCOPE,validClientId } from '../lifeos/pocket/src/sync/google-auth'
const clientId='1234567890-test-client.apps.googleusercontent.com'
afterEach(()=>{vi.unstubAllGlobals()})
function googleMock(){
 let options:any
 const request=vi.fn(),init=vi.fn(value=>{options=value;return {requestAccessToken:request}})
 vi.stubGlobal('window',{google:{accounts:{oauth2:{initTokenClient:init,hasGrantedAllScopes:(response:any,scope:string)=>response.scope===scope}}}})
 return {request,init,get options(){return options}}
}
describe('browser OAuth without persistent tokens',()=>{
 it('validates public Web client IDs and only requests drive.appdata',async()=>{
  expect(validClientId(clientId)).toBe(true);expect(validClientId('client-secret')).toBe(false)
  const mock=googleMock(),auth=new GoogleAuthorization();await auth.prepare(clientId);expect(mock.options.scope).toBe(DRIVE_SCOPE);expect(mock.options.include_granted_scopes).toBe(false)
 })
 it('opens authorization synchronously on the user call and expires the in-memory token',async()=>{
  let now=1000;const mock=googleMock(),auth=new GoogleAuthorization(()=>now);await auth.prepare(clientId)
  const promise=auth.authorize();expect(mock.request).toHaveBeenCalledOnce();mock.options.callback({access_token:'secret',expires_in:60,scope:DRIVE_SCOPE});await promise;expect(auth.token()).toBe('secret');now+=31000;expect(()=>auth.token()).toThrow('过期');expect(auth.connected).toBe(false)
 })
 it('handles cancelled popups and missing scopes without retaining a token',async()=>{
  const mock=googleMock(),auth=new GoogleAuthorization();await auth.prepare(clientId)
  const cancelled=auth.authorize();mock.options.error_callback({type:'popup_closed'});await expect(cancelled).rejects.toThrow('关闭');expect(auth.connected).toBe(false)
  const denied=auth.authorize();mock.options.callback({access_token:'ungranted',expires_in:3600,scope:''});await expect(denied).rejects.toThrow('未获得');expect(auth.connected).toBe(false)
 })
})
