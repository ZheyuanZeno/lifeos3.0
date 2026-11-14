import type { CloudAck,CloudFile,CloudBatch,CloudState } from './sync/types'
import Dexie, { type Table } from 'dexie'
import type { Module,LifeRecord,Routine,Completion,Session,Operation,LocalState } from './model'
import type { MediaAsset,RemoteMedia } from './media'
export class PocketDatabase extends Dexie {
  modules!:Table<Module,string>; records!:Table<LifeRecord,string>; routines!:Table<Routine,string>
  completions!:Table<Completion,string>; sessions!:Table<Session,string>; operations!:Table<Operation,string>; local!:Table<LocalState,string>
  cloudAcks!:Table<CloudAck,string>; cloudFiles!:Table<CloudFile,string>; cloudBatches!:Table<CloudBatch,string>; cloudState!:Table<CloudState,string>
  media!:Table<MediaAsset,string>; remoteMedia!:Table<RemoteMedia,string>
  constructor(name='lifeos-pocket-v1'){super(name);this.version(1).stores({modules:'id, kind',records:'id, date, module_id, type, [type+date]',routines:'id, order',completions:'id, date, routineId',sessions:'id, subjectId, startedAt, endedAt',operations:'id, uploaded, deviceId, &[deviceId+sequence], [entity+recordId]',local:'key'});this.version(2).stores({cloudAcks:'key, accountId, operationId',cloudFiles:'key, accountId, fileId',cloudBatches:'key, accountId, [accountId+status]',cloudState:'key'});this.version(3).stores({media:'file',remoteMedia:'key, accountId'});this.version(4).stores({});this.version(5).stores({})}
}
export const db=new PocketDatabase()
