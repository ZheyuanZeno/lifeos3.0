"""Invoked by the workerd harness against an isolated, temporary Sync Space."""
import json
import os
from pathlib import Path
import sys
import tempfile
import shutil
import subprocess
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lifeos'))
import archive_agent as archive

endpoint, bootstrap = sys.argv[1:3]
if bootstrap.startswith('@'):
    bootstrap = Path(bootstrap[1:]).read_text('utf-8').strip()
with tempfile.TemporaryDirectory(prefix='lifeos-workerd-archive-', dir=os.environ.get('LIFEOS_TEST_TMP')) as folder:
    data = Path(folder)
    (data / 'attachments').mkdir()
    (data / 'backups').mkdir()
    credentials = archive.new_credentials()
    config = {'data_dir': str(data), 'endpoint': endpoint, 'primary': True}
    client = archive.Client(config, credentials)
    client.request('create', {'bootstrap': bootstrap, 'public_key': credentials['public_key'], 'recovery_hash': archive.sha(credentials['recovery'].encode()), 'kind': 'archive'})
    agent = archive.ArchiveAgent(config, client)
    original = archive.app.load()
    module = archive.app.validate_module({'id': 'archive-plans', 'name': 'Archive fixture plans', 'kind': 'plans'})
    record = archive.app.validate({'id': 'fixture-task', 'module_id': module['id'], 'type': 'task', 'date': '2026-11-01', 'title': 'Temporary archive fixture', 'body': 'Old offline history'})
    archive.app.save(dict(original, modules=original['modules'] + [module], records=original['records'] + [record]))
    file = 'a' * 32 + '.wav'
    media = b'RIFF' + bytes(range(256)) * 1000
    archive.durable(data / 'attachments' / file, media)
    head = agent.round()
    status = client.request('status')
    assert head > 0 and status['archive']['cursor'] == head
    assert status['mode'] == 'staging'
    assert status['manifest']['media_count'] == 1
    assert archive.sha(agent.read_media(file, len(media))) == archive.sha(media)
    assert agent.round() == head, 'Retry created duplicate history'
    backup = agent.backup()
    assert (backup / 'attachments' / file).read_bytes() == media
    assert any((data / 'sync-archive' / 'raw').glob('*.json'))
    with archive.app.connect() as db:
        assert db.execute('SELECT count(*) FROM archive_receipts').fetchone()[0] > 0
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    # Restore the real backup into another directory: retained receipts must not skip raw replay.
    restored_data = data / 'restored-fixture'
    shutil.copytree(backup, restored_data)
    vault = data / 'restore.vault'
    archive.save_vault(vault, credentials)
    restored_config = dict(config, data_dir=str(restored_data), vault=str(vault))
    config_file = data / 'restore-config.json'
    archive.durable(config_file, archive.compact(restored_config).encode())
    process = subprocess.run([sys.executable, 'lifeos/archive_agent.py', '--config', str(config_file), '--rebind-archive', '--confirm-restore'], capture_output=True, text=True, timeout=30)
    assert process.returncode == 0, process.stderr
    restored = archive.ArchiveAgent(restored_config, archive.Client(restored_config, credentials))
    assert restored.round() == head
    assert any((restored.root / 'raw').glob('*.json'))
    assert json.loads((restored.root / 'restore-replay.json').read_text())['complete'] is True
    assert client.request('status')['archive']['archive_id'] == agent.identity['archive_id']
    assert (restored_data / 'attachments' / file).read_bytes() == media
    print('PASS: Python P-256 interoperability, offline desktop history+orphan media upload, raw SHA archive, durable ACK, retry idempotency, SQLite+media backup')
    print('PASS: portable backup restoration, explicit single-archive rebind, forced raw/media replay before restored durable ACK')
