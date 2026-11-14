import copy
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lifeos'))
import app
import pocket_sync


class DesktopAdapterTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix='lifeos-test-', dir=os.environ.get('LIFEOS_TEST_TMP'))
        self.original = app.DATA
        app.DATA = Path(self.folder.name)
        (app.DATA / 'attachments').mkdir()
        (app.DATA / 'backups').mkdir()
        app.initialize()

    def tearDown(self):
        app.DATA = self.original
        self.folder.cleanup()

    def record(self, title='计划'):
        return app.validate({'id':'task1','type':'task','date':'2026-11-13','title':title,'body':'保留原文','module_id':'plans'})

    def create(self):
        doc = app.load()
        doc['modules'] = [app.validate_module({'id':'plans','name':'计划','kind':'plans'})]
        doc['records'] = [self.record()]
        app.save(doc)
        return app.load()

    def receive(self, incoming):
        doc = app.load()
        with app.connect() as db:
            pocket_sync.capture(db, doc, doc)
        with app.connect() as db:
            candidate, extensions = pocket_sync.preview(db, doc, incoming, app.validate_module, app.validate)
        app.save(app.normalize(candidate), remote=(incoming, extensions))

    def test_existing_sqlite_and_readable_exports_are_preserved(self):
        doc = self.create()
        app.initialize()
        self.assertEqual(app.load()['records'], doc['records'])
        self.assertEqual(json.loads((app.DATA/'records.json').read_text('utf8'))['records'], doc['records'])
        self.assertTrue((app.DATA/'days/2026-11-13.md').is_file())
        with app.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM records').fetchone()[0], 1)
            self.assertGreater(len(pocket_sync.operations(db)), 0)

    def test_idempotent_phone_to_desktop_and_desktop_to_phone(self):
        doc = self.create()
        op = {'id':'phone_op1','deviceId':'phone','sequence':1,'clock':20,'context':{},'entity':'records','recordId':'task1','patch':{'title':'手机离线修改'},'timestamp':'2026-11-13T12:00:00Z','uploaded':0}
        self.receive([op]);self.receive([op])
        self.assertEqual(app.load()['records'][0]['title'], '手机离线修改')
        self.assertEqual(app.load()['records'][0]['body'], '保留原文')
        desktop = app.load();desktop['records'][0]['body'] = '桌面补充';app.save(desktop)
        with app.connect() as db:
            ops = pocket_sync.operations(db)
            row = pocket_sync.materialize([o for o in ops if o['entity']=='records' and o['recordId']=='task1'])
            self.assertEqual(row['title'], '手机离线修改')
            self.assertEqual(row['body'], '桌面补充')
            self.assertEqual(sum(o['id']=='phone_op1' for o in ops), 1)

    def test_malformed_exchange_does_not_overwrite_sqlite(self):
        doc = self.create()
        op = {'id':'bad','deviceId':'phone','sequence':1,'clock':20,'context':{},'entity':'records','recordId':'task1','patch':{'date':'2026-99-99'},'timestamp':'2026-11-13T12:00:00Z','uploaded':0}
        with self.assertRaises(ValueError):
            self.receive([op])
        self.assertEqual(app.load()['records'], doc['records'])
        with app.connect() as db:
            self.assertIsNone(db.execute("SELECT id FROM pocket_operations WHERE id='bad'").fetchone())

    def test_operation_id_collision_is_rejected(self):
        self.create()
        with app.connect() as db:
            op = pocket_sync.operations(db)[0]
            bad = copy.deepcopy(op);bad['patch']['name'] = 'collision'
            with self.assertRaises(ValueError):
                pocket_sync.add_operation(db,bad)

    def test_causal_delete_and_explicit_restore(self):
        base = {'id':'a','recordId':'task','deviceId':'a','sequence':1,'clock':1,'context':{},'entity':'records','patch':{'title':'原文','deleted':False},'timestamp':'2026-11-13T12:00:00Z','uploaded':1}
        deleted = {**base,'id':'b','deviceId':'b','clock':2,'context':{'a':1},'patch':{'deleted':True}}
        stale = {**base,'id':'c','deviceId':'c','clock':99,'context':{'a':1},'patch':{'title':'旧设备','deleted':False}}
        self.assertTrue(pocket_sync.materialize([base,deleted,stale])['deleted'])
        restore = {**base,'id':'d','deviceId':'d','clock':100,'context':{'a':1,'b':1,'c':1},'patch':{'deleted':False}}
        self.assertFalse(pocket_sync.materialize([base,deleted,stale,restore])['deleted'])

    def test_session_extension_is_retained_without_replacing_legacy_data(self):
        self.create()
        stamp='2026-11-13T12:00:00Z'
        row={'subjectId':'task1','subjectKind':'record','title':'计划','startedAt':stamp,'endedAt':'2026-11-13T12:30:00Z','timeZone':'Europe/Berlin','deviceId':'phone','created_at':stamp,'updated_at':stamp}
        op={'id':'session_op','recordId':'session1','deviceId':'phone','sequence':1,'clock':30,'context':{},'entity':'sessions','patch':row,'timestamp':stamp,'uploaded':0}
        self.receive([op]);self.receive([op])
        with app.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM pocket_entities').fetchone()[0],1)
            self.assertEqual(db.execute('SELECT count(*) FROM records').fetchone()[0],1)
        self.assertEqual(app.load()['records'][0]['id'],'task1')

    def test_plan_deadline_and_scheduled_minute_roundtrip_without_changing_other_record_fields(self):
        self.create()
        props={'plan_deadline':'2026-11-20','planned_start':'2026-11-14T13:35:00.000Z','time_zone':'Europe/Berlin','custom':'保留'}
        op={'id':'plan_schedule','deviceId':'phone','sequence':1,'clock':30,'context':{},'entity':'records','recordId':'task1','patch':{'properties':props},'timestamp':'2026-11-14T12:00:00Z','uploaded':0}
        self.receive([op]);self.assertEqual(app.load()['records'][0]['properties'],props)
        invalid={**op,'id':'bad_deadline','sequence':2,'clock':31,'context':{'phone':1},'patch':{'properties':{**props,'plan_deadline':'2026-02-30'}}}
        with self.assertRaises(ValueError):
            self.receive([invalid])
        self.assertEqual(app.load()['records'][0]['properties'],props)
        cleared={**invalid,'id':'clear_schedule','patch':{'properties':{**props,'plan_deadline':'','planned_start':''}}}
        self.receive([cleared]);saved=app.load()['records'][0]
        self.assertEqual(saved['properties']['plan_deadline'],'')
        self.assertEqual(saved['properties']['planned_start'],'')
        self.assertEqual(saved['properties']['custom'],'保留')
        self.assertEqual(saved['body'],'保留原文')
        self.assertEqual(saved['status'],'todo')

    def test_shared_timer_stop_wins_concurrent_resume_as_a_valid_atomic_snapshot(self):
        self.create()
        stamp='2026-11-14T08:00:00Z'
        row={'subjectId':'task1','subjectKind':'record','title':'计划','startedAt':stamp,'endedAt':None,'timeZone':'UTC','deviceId':'phone','created_at':stamp,'updated_at':stamp}
        base={'id':'timer_base','recordId':'shared_timer','deviceId':'phone','sequence':1,'clock':30,'context':{},'entity':'sessions','patch':row,'timestamp':stamp,'uploaded':0}
        paused={**base,'id':'timer_pause','sequence':2,'clock':31,'context':{'phone':1},'patch':{'endedAt':None,'startedAt':stamp,'pauses':[{'startedAt':'2026-11-14T08:10:00Z','endedAt':None}]}}
        resumed={**base,'id':'timer_resume','sequence':3,'clock':33,'context':{'phone':2},'patch':{'endedAt':None,'startedAt':stamp,'pauses':[{'startedAt':'2026-11-14T08:10:00Z','endedAt':'2026-11-14T08:25:00Z'}]}}
        stopped={**base,'id':'timer_stop','deviceId':'tablet','sequence':1,'clock':32,'context':{'phone':2},'patch':{'startedAt':stamp,'endedAt':'2026-11-14T08:15:00Z','pauses':[{'startedAt':'2026-11-14T08:10:00Z','endedAt':'2026-11-14T08:15:00Z'}]}}
        self.receive([base,paused]);self.receive([stopped]);self.receive([resumed])
        with app.connect() as db:
            saved=json.loads(db.execute("SELECT payload FROM pocket_entities WHERE id='shared_timer'").fetchone()[0])
            self.assertEqual(saved['endedAt'],stopped['patch']['endedAt'])
            self.assertEqual(saved['pauses'],stopped['patch']['pauses'])
            self.assertEqual(saved['deviceId'],'phone')
        forward=pocket_sync.materialize([base,paused,resumed,stopped])
        reverse=pocket_sync.materialize([stopped,resumed,paused,base])
        self.assertEqual(forward,reverse)
        pocket_sync.validate_extension('sessions',forward)

    def test_session_notes_are_stored_cleared_and_invalid_updates_leave_existing_data_intact(self):
        self.create()
        stamp='2026-11-14T08:00:00Z'
        row={'subjectId':'task1','subjectKind':'record','title':'计划','startedAt':stamp,'endedAt':'2026-11-14T08:10:00Z','timeZone':'UTC','deviceId':'phone','created_at':stamp,'updated_at':stamp,'note':'复习第三章\n😀 <b>保留原文</b>'}
        op={'id':'note_op','recordId':'noted_session','deviceId':'phone','sequence':1,'clock':30,'context':{},'entity':'sessions','patch':row,'timestamp':stamp,'uploaded':0}
        self.receive([op]);self.receive([op])
        with app.connect() as db:
            saved=json.loads(db.execute("SELECT payload FROM pocket_entities WHERE id='noted_session'").fetchone()[0])
            self.assertEqual(saved['note'],row['note'])
        for value in (None, 42, 'x'*10001, '😀'*5001):
            invalid={**op,'id':'invalid_note','sequence':2,'clock':31,'context':{'phone':1},'patch':{'note':value}}
            with self.assertRaises(ValueError):
                self.receive([invalid])
        cleared={**op,'id':'clear_note','sequence':2,'clock':31,'context':{'phone':1},'patch':{'note':''}}
        self.receive([cleared])
        with app.connect() as db:
            saved=json.loads(db.execute("SELECT payload FROM pocket_entities WHERE id='noted_session'").fetchone()[0])
            self.assertEqual(saved['note'],'')
            self.assertEqual(saved['startedAt'],stamp)
            self.assertIsNone(db.execute("SELECT id FROM pocket_operations WHERE id='invalid_note'").fetchone())
        self.assertEqual(app.load()['records'][0]['id'],'task1')

    def test_paused_session_sync_preserves_intervals_and_rejects_an_unclosed_pause_on_end(self):
        self.create()
        stamp='2026-11-14T08:00:00Z'
        row={'subjectId':'task1','subjectKind':'record','title':'计划','startedAt':stamp,'endedAt':None,'timeZone':'Europe/Berlin','deviceId':'phone','created_at':stamp,'updated_at':stamp,'pauses':[{'startedAt':'2026-11-14T08:10:00Z','endedAt':None}]}
        op={'id':'paused_op','recordId':'paused_session','deviceId':'phone','sequence':1,'clock':30,'context':{},'entity':'sessions','patch':row,'timestamp':stamp,'uploaded':0}
        self.receive([op])
        with app.connect() as db:
            saved=json.loads(db.execute("SELECT payload FROM pocket_entities WHERE id='paused_session'").fetchone()[0])
            self.assertEqual(saved['pauses'],row['pauses'])
        invalid={**op,'id':'invalid_end','sequence':2,'clock':31,'context':{'phone':1},'patch':{'endedAt':'2026-11-14T08:20:00Z'}}
        with self.assertRaises(ValueError):
            self.receive([invalid])
        valid={**invalid,'id':'valid_end','patch':{'endedAt':'2026-11-14T08:20:00Z','pauses':[{'startedAt':'2026-11-14T08:10:00Z','endedAt':'2026-11-14T08:15:00Z'}]}}
        self.receive([valid])
        with app.connect() as db:
            saved=json.loads(db.execute("SELECT payload FROM pocket_entities WHERE id='paused_session'").fetchone()[0])
            self.assertEqual(saved['pauses'][0]['endedAt'],'2026-11-14T08:15:00Z')


if __name__ == '__main__':
    unittest.main()
