import {expect,it} from 'vitest'
import {PocketDatabase} from '../lifeos/pocket/src/database'
import {initialize,exportBackup} from '../lifeos/pocket/src/repository'
import {newSyncIdentity,saveSyncIdentity,signedHeaders,encryptRecovery,decryptRecovery,randomId} from '../lifeos/pocket/src/sync/identity'
it('persists nonexportable keys without including them or the binding in business backups',async()=>{
 const db=new PocketDatabase('sync-identity-'+randomId(8));try{await initialize(db);const identity=await newSyncIdentity(randomId(),'Fixture');await saveSyncIdentity(db,identity);db.close();await db.open();const restored=(await db.local.get('sync-identity-v1'))!.value as typeof identity;expect(restored.privateKey.extractable).toBe(false);const headers=await signedHeaders(restored,'status','{}');expect(headers['X-LifeOS-Signature']).toHaveLength(88);await expect(crypto.subtle.exportKey('pkcs8',restored.privateKey)).rejects.toThrow();const backup=JSON.stringify(await exportBackup(db));expect(backup).not.toContain(identity.spaceId);expect(backup).not.toContain('privateKey')}finally{await db.delete()}
})
it('authenticates encrypted recovery content, rejects wrong passwords and bounded format violations',async()=>{
 const spaceId=randomId(),recovery=randomId(),file=await encryptRecovery(spaceId,recovery,'fixture recovery passphrase')
 expect(JSON.stringify(file)).not.toContain(recovery);expect(await decryptRecovery(file,'fixture recovery passphrase')).toEqual({spaceId,recovery});await expect(decryptRecovery(file,'wrong password')).rejects.toThrow();await expect(decryptRecovery({...file,iterations:1},'fixture recovery passphrase')).rejects.toThrow('格式');await expect(decryptRecovery({...file,salt:'a'.repeat(10000)},'fixture recovery passphrase')).rejects.toThrow('格式')
})
