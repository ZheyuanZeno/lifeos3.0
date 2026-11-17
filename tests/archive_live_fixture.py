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
    config = {'data_dir': str(data), 'endpoint': endpoint, 'primary': True, 'source_confirmed': False}
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
    assert agent.round() == 0
    assert client.request('status')['manifest']['media_count'] == 0
    # Preparation must release the archive contributor before a PWA can verify missing media.
    pwa_credentials = archive.new_credentials()
    pwa_credentials['space_id'] = credentials['space_id']
    pwa = archive.Client(config, pwa_credentials)
    pair_id, pair_secret = archive.secrets.token_hex(32), archive.secrets.token_hex(32)
    pair = pwa.request('pair/request', {'pair_id': pair_id, 'secret': pair_secret, 'public_key': pwa_credentials['public_key'], 'kind': 'pwa'})
    client.request('pair/approve', {'pair_id': pair_id, 'secret': pair_secret, 'fingerprint': pair['fingerprint']})
    pwa.request('pair/claim', {'pair_id': pair_id, 'secret': pair_secret})
    prepared = pwa.request('migration/prepare', {'source_confirmed': True, 'backup_digest': archive.sha(b'fixture preflight backup')})
    assert prepared['verified'] is False
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
    # Two explicit wizard choices + two current checks + a complete physical backup auto-enable.
    second_credentials = archive.new_credentials()
    second_credentials['space_id'] = credentials['space_id']
    second = archive.Client(config, second_credentials)
    next_pair, next_secret = archive.secrets.token_hex(32), archive.secrets.token_hex(32)
    requested = second.request('pair/request', {'pair_id': next_pair, 'secret': next_secret, 'public_key': second_credentials['public_key'], 'kind': 'pwa'})
    client.request('pair/approve', {'pair_id': next_pair, 'secret': next_secret, 'fingerprint': requested['fingerprint']})
    second.request('pair/claim', {'pair_id': next_pair, 'secret': next_secret})
    full_manifest = client.request('manifest')
    verify = {'head': full_manifest['head'], 'manifest': {k: v for k, v in full_manifest.items() if k != 'head'}, 'source_confirmed': True, 'backup_digest': archive.sha(b'fixture preflight backup')}
    for device in (pwa, second):
        device.request('migration/prepare', {'source_confirmed': True, 'backup_digest': verify['backup_digest'], 'auto_activate': True})
        device.request('migration/verify', verify)
    assert client.request('status')['mode'] == 'staging'
    restored.round()
    enabled = client.request('status')
    assert enabled['mode'] == 'active'
    saved_backup = json.loads((restored.root / 'migration-complete-backup.json').read_text())
    assert archive.sha((Path(saved_backup['path']) / 'manifest.json').read_bytes()) == enabled['archive']['backup_digest']
    print('PASS: Python P-256 interoperability, offline desktop history+orphan media upload, raw SHA archive, durable ACK, retry idempotency, SQLite+media backup')
    print('PASS: portable backup restoration, explicit single-archive rebind, forced raw/media replay before restored durable ACK')
    print('PASS: migration preparation releases dormant archive contribution without claiming verification or activation')
    print('PASS: two opt-in devices auto-enable only after current verification, durable archive and full physical backup')
