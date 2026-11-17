"""Archive tests use temporary data only; no real account or database is read."""
import json
from contextlib import closing
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lifeos'))
try:
    import archive_agent as archive
except ImportError:
    archive = None


@unittest.skipIf(archive is None, 'Install requirements-archive.txt in the isolated archive environment')
class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix='lifeos-archive-test-', dir=os.environ.get('LIFEOS_TEST_TMP'))
        self.data = Path(self.folder.name)
        (self.data / 'attachments').mkdir()
        (self.data / 'backups').mkdir()
        self.previous = archive.app.DATA

    def tearDown(self):
        archive.app.DATA = self.previous
        self.folder.cleanup()

    def test_windows_vault_roundtrip_and_no_plain_private_key(self):
        value = archive.new_credentials()
        path = self.data / 'credentials.vault'
        archive.save_vault(path, value)
        self.assertEqual(json.loads(archive.protect(path.read_bytes(), True)), value)
        if os.name == 'nt':
            self.assertNotIn(b'PRIVATE KEY', path.read_bytes())

    def test_crash_before_business_commit_withholds_receipts_and_archive_ack(self):
        class Broken:
            credentials = {'device_id': 'archive'}
            calls = []
            def request(self, action, value=None):
                self.calls.append(action)
                if action == 'status':
                    return {'head': 1, 'mode': 'staging'}
                if action == 'changes':
                    return {'items': [{'seq': 1, 'kind': 'batch', 'id': 'x', 'batch_id': 'x', 'digest': '0' * 64}], 'next_after': None}
                if action == 'batch/get':
                    return {'data': 'e30=', 'batch_id': 'x'}
                return {}
        client = Broken()
        agent = archive.ArchiveAgent({'data_dir': str(self.data)}, client)
        # Empty initial database so no unrelated outgoing operations precede the failure.
        agent.upload_operations = lambda: None
        with self.assertRaisesRegex(ValueError, 'integrity'):
            agent.round()
        with archive.app.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM archive_receipts').fetchone()[0], 0)
        self.assertNotIn('archive/ack', client.calls)

    def test_full_backup_retains_original_database_and_all_orphan_media(self):
        class Local:
            credentials = {'device_id': 'archive'}
        agent = archive.ArchiveAgent({'data_dir': str(self.data)}, Local())
        name = 'a' * 32 + '.wav'
        content = b'RIFF-test-recording'
        archive.durable(self.data / 'attachments' / name, content)
        first, second = agent.backup(), agent.backup()
        self.assertTrue(first.exists())
        self.assertEqual((second / 'attachments' / name).read_bytes(), content)
        with closing(sqlite3.connect(second / 'lifeos.sqlite')) as db:
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
        manifest = json.loads((second / 'manifest.json').read_text())
        self.assertEqual(manifest['media'][name], archive.sha(content))

    def test_copied_archive_identity_cannot_become_second_primary(self):
        class Local:
            credentials = {'device_id': 'archive'}
        agent = archive.ArchiveAgent({'data_dir': str(self.data)}, Local())
        identity = dict(agent.identity, primary_os='linux' if os.name == 'nt' else 'windows')
        archive.durable(agent.root / 'identity.json', archive.compact(identity).encode())
        with self.assertRaisesRegex(ValueError, 'explicit restore'):
            archive.ArchiveAgent({'data_dir': str(self.data)}, Local())

    def test_staging_waits_for_explicit_source_confirmation_without_uploading(self):
        class Waiting:
            credentials = {'device_id': 'archive'}
            calls = []
            def request(self, action, value=None):
                self.calls.append(action)
                if action != 'status':
                    raise AssertionError('Unconfirmed private history must not upload')
                return {'head': 0, 'migration_checks': []}
        client = Waiting()
        agent = archive.ArchiveAgent({'data_dir': str(self.data), 'source_confirmed': False}, client)
        self.assertEqual(agent.round(), 0)
        self.assertEqual(client.calls, ['status'])
        self.assertTrue(json.loads((agent.root / 'status.json').read_text())['migration_waiting'])

    def test_receipts_never_cross_sync_space_bindings(self):
        class Local:
            credentials = {'device_id': 'archive', 'space_id': 'a' * 64}
        archive.ArchiveAgent({'data_dir': str(self.data)}, Local())
        other = Local()
        other.credentials = {'device_id': 'archive', 'space_id': 'b' * 64}
        with self.assertRaisesRegex(ValueError, 'different Sync Space'):
            archive.ArchiveAgent({'data_dir': str(self.data)}, other)


if __name__ == '__main__':
    unittest.main()
