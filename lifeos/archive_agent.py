"""Independent full-history Sync Hub client. Never prunes cloud or local history."""
import argparse
from contextlib import closing
import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import platform
import secrets
import sqlite3
import time
import sys
import urllib.request
import urllib.error
import uuid

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
import app
import pocket_sync
from data_lock import data_lock

CHUNK = 98304


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True)


def sha(value):
    return hashlib.sha256(value).hexdigest()


def durable(path, content):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with open(tmp, 'xb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        if os.name == 'nt':
            import ctypes
            from ctypes import wintypes
            move = ctypes.WinDLL('kernel32', use_last_error=True).MoveFileExW
            move.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD]
            move.restype = wintypes.BOOL
            if not move(str(tmp), str(path), 0x1 | 0x8):  # replace + write-through metadata
                raise ctypes.WinError(ctypes.get_last_error())
        else:
            os.replace(tmp, path)
            fd = os.open(str(path.parent), os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    finally:
        if tmp.exists():
            tmp.unlink()


def protect(content, decrypt=False):
    if os.name != 'nt':
        return content
    import ctypes
    from ctypes import wintypes
    class Blob(ctypes.Structure):
        _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]
    buffer = ctypes.create_string_buffer(content)
    source = Blob(len(content), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    result = Blob()
    crypt = ctypes.windll.crypt32
    ok = (crypt.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(result)) if decrypt
          else crypt.CryptProtectData(ctypes.byref(source), 'LifeOS archive', None, None, None, 1, ctypes.byref(result)))
    if not ok:
        raise OSError('Windows credential protection failed')
    try:
        return ctypes.string_at(result.data, result.size)
    finally:
        ctypes.windll.kernel32.LocalFree(result.data)


def save_vault(path, credentials):
    durable(path, protect(compact(credentials).encode()))
    if os.name != 'nt':
        os.chmod(path, 0o600)


class Client:
    def __init__(self, config, credentials):
        self.config, self.credentials = config, credentials
        self.key = serialization.load_pem_private_key(credentials['private_key'].encode(), None)

    def request(self, action, value=None):
        body = compact(value or {}).encode()
        stamp, nonce = str(int(time.time() * 1000)), secrets.token_hex(16)
        c = self.credentials
        envelope = json.dumps(['lifeos-sync-auth-v1', c['space_id'], c['device_id'], action, stamp, nonce, sha(body)], separators=(',', ':')).encode()
        r, s = decode_dss_signature(self.key.sign(envelope, ec.ECDSA(hashes.SHA256())))
        signature = base64.b64encode(r.to_bytes(32, 'big') + s.to_bytes(32, 'big')).decode()
        headers = {'Content-Type': 'application/json', 'User-Agent': 'LifeOSDesktop/1.0', 'X-LifeOS-Space': c['space_id'], 'X-LifeOS-Device': c['device_id'], 'X-LifeOS-Time': stamp, 'X-LifeOS-Nonce': nonce, 'X-LifeOS-Signature': signature}
        request = urllib.request.Request(self.config['endpoint'].rstrip('/') + '/v1/' + action, body, headers)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            # Only server errors are logged; never print the signed request or vault.
            value = json.loads(error.read(8192))
            raise ValueError(value.get('error', 'Sync service rejected request')) from None


def new_credentials():
    key = ec.generate_private_key(ec.SECP256R1())
    numbers = key.public_key().public_numbers()
    enc = lambda n: base64.urlsafe_b64encode(n.to_bytes(32, 'big')).decode().rstrip('=')
    return {'space_id': secrets.token_hex(32), 'device_id': uuid.uuid4().hex, 'recovery': secrets.token_hex(32), 'private_key': key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode(), 'public_key': {'kty': 'EC', 'crv': 'P-256', 'x': enc(numbers.x), 'y': enc(numbers.y), 'ext': True, 'key_ops': ['verify']}}


def initialize_config(config_path, data_dir, endpoint, bootstrap_file):
    if config_path.exists():
        raise ValueError('Configuration exists; refusing to overwrite credentials')
    if not endpoint.startswith('https://') and not endpoint.startswith('http://127.0.0.1:'):
        raise ValueError('Sync endpoint requires HTTPS')
    vault = config_path.with_suffix('.vault')
    if vault.exists():
        raise ValueError('Credential vault already exists; refusing to overwrite')
    credentials = new_credentials()
    config = {'data_dir': str(Path(data_dir).resolve()), 'endpoint': endpoint.rstrip('/'), 'vault': str(vault.resolve()), 'primary': True, 'poll_seconds': 45, 'python': sys.executable, 'source_confirmed': False}
    # Persist credentials first so a lost creation response is recoverable without new identity.
    save_vault(vault, credentials)
    durable(config_path, compact(config).encode())
    Client(config, credentials).request('create', {'bootstrap': Path(bootstrap_file).read_text('utf-8').strip(), 'public_key': credentials['public_key'], 'recovery_hash': sha(credentials['recovery'].encode()), 'label': 'Windows primary archive' if os.name == 'nt' else 'Primary archive', 'kind': 'archive'})
    durable(Path(config['data_dir']) / 'sync-archive' / 'connection.json', compact({'space_id': credentials['space_id'], 'endpoint': config['endpoint'], 'config_file': str(config_path.resolve())}).encode())
    return config


class ArchiveAgent:
    def __init__(self, config, client=None):
        self.config = config
        self.data = Path(config['data_dir']).resolve()
        self.root = self.data / 'sync-archive'
        self.root.mkdir(parents=True, exist_ok=True)
        self.client = client or Client(config, json.loads(protect(Path(config['vault']).read_bytes(), True)))
        self.registered = False
        app.DATA = self.data
        with data_lock(self.data):
            app.initialize()
            with app.connect() as db:
                for sql in [
                    'CREATE TABLE IF NOT EXISTS archive_receipts (seq INTEGER PRIMARY KEY, kind TEXT, id TEXT, digest TEXT)',
                    'CREATE TABLE IF NOT EXISTS archive_uploaded (operation_id TEXT PRIMARY KEY)',
                    'CREATE TABLE IF NOT EXISTS archive_outbox (id TEXT PRIMARY KEY, body BLOB, digest TEXT, confirmed INTEGER DEFAULT 0)',
                    'CREATE TABLE IF NOT EXISTS archive_media_confirmed (file TEXT PRIMARY KEY, sha TEXT, size INTEGER, mtime INTEGER)',
                ]:
                    db.execute(sql)
        identity_file = self.root / 'identity.json'
        with data_lock(self.data):
            if not identity_file.exists():
                durable(identity_file, compact({'archive_id': secrets.token_hex(32), 'storage_id': secrets.token_hex(32), 'primary_os': 'windows' if os.name == 'nt' else 'linux', 'data_dir': str(self.data), 'host': platform.node(), 'space_id': self.client.credentials.get('space_id', 'fixture')}).encode())
            self.identity = json.loads(identity_file.read_text('utf-8'))
            if 'space_id' not in self.identity:
                with app.connect() as db:
                    if any(db.execute('SELECT count(*) FROM ' + table).fetchone()[0] for table in ('archive_uploaded', 'archive_receipts', 'archive_outbox')):
                        raise ValueError('Legacy archive receipts require an explicit space migration')
                self.identity['space_id'] = self.client.credentials.get('space_id', 'fixture')
                durable(identity_file, compact(self.identity).encode())
            if self.identity['space_id'] != self.client.credentials.get('space_id', 'fixture'):
                raise ValueError('Archive receipts belong to a different Sync Space; automatic account switching is forbidden')
        expected_os = 'windows' if os.name == 'nt' else 'linux'
        if self.identity['data_dir'] != str(self.data) or self.identity['primary_os'] != expected_os or self.identity['host'] != platform.node():
            raise ValueError('Archive storage/OS/host changed: explicit restore and rebind required')

    def backup(self):
        stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        target = self.root / 'backups' / stamp
        target.mkdir(parents=True)
        with data_lock(self.data):
            with closing(sqlite3.connect(self.data / 'lifeos.sqlite')) as source, closing(sqlite3.connect(target / 'lifeos.sqlite')) as destination:
                source.backup(destination)
                if destination.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise ValueError('Archive backup integrity check failed')
            with open(target / 'lifeos.sqlite', 'r+b') as stream:
                os.fsync(stream.fileno())
            files = {}
            for file in (self.data / 'attachments').glob('*'):
                if file.is_file() and app.ATTACHMENT.fullmatch(file.name):
                    content = file.read_bytes()
                    durable(target / 'attachments' / file.name, content)
                    files[file.name] = sha(content)
            durable(target / 'manifest.json', compact({'format': 'lifeos-archive-backup-v1', 'created_at': app.now(), 'space_id': self.identity['space_id'], 'archive_id': self.identity['archive_id'], 'database_sha256': sha((target / 'lifeos.sqlite').read_bytes()), 'media': files}).encode())
        return target

    def upload_media(self):
        import mimetypes
        for path in sorted((self.data / 'attachments').glob('*')):
            if not path.is_file() or not app.ATTACHMENT.fullmatch(path.name):
                continue
            stat = path.stat()
            with app.connect() as db:
                known = db.execute('SELECT size,mtime FROM archive_media_confirmed WHERE file=?', (path.name,)).fetchone()
            if known and known == (stat.st_size, stat.st_mtime_ns):
                continue
            content = path.read_bytes()
            if not 0 < len(content) <= 32 * 1024 * 1024:
                raise ValueError('Historical attachment exceeds supported size; original retained')
            digest = sha(content)
            row = self.client.request('media/status', {'file': path.name})
            if row and (row['sha'] != digest or row['size'] != len(content)):
                raise ValueError('Immutable media collision; original retained')
            if row and row['ready']:
                with app.connect() as db:
                    db.execute('INSERT OR REPLACE INTO archive_media_confirmed VALUES (?,?,?,?)', (path.name, digest, stat.st_size, stat.st_mtime_ns))
                continue
            mime = {'m4a': 'audio/mp4', 'mp4': 'audio/mp4', 'webm': 'audio/webm', 'ogg': 'audio/ogg', 'wav': 'audio/wav', 'txt': 'text/plain'}.get(path.suffix[1:]) or mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
            if not row:
                row = self.client.request('media/begin', {'file': path.name, 'file_id': path.name.replace('.', '_'), 'sha256': digest, 'size': len(content), 'mime': mime})
            for part in row['missing']:
                self.client.request('media/put', {'file': path.name, 'part': part, 'data': base64.b64encode(content[part * CHUNK:(part + 1) * CHUNK]).decode()})
            self.client.request('media/commit', {'file': path.name})
            # Verify actual stored bytes, not just an upload acknowledgement.
            if sha(self.read_media(path.name, len(content))) != digest:
                raise ValueError('Uploaded media readback failed')
            with app.connect() as db:
                db.execute('INSERT OR REPLACE INTO archive_media_confirmed VALUES (?,?,?,?)', (path.name, digest, stat.st_size, stat.st_mtime_ns))

    def read_media(self, file, size):
        content = bytearray()
        for part in range((size + CHUNK - 1) // CHUNK):
            row = self.client.request('media/get', {'file': file, 'part': part})
            if not row:
                raise ValueError('Missing media chunk')
            content.extend(base64.b64decode(row['data'], validate=True))
        if len(content) != size:
            raise ValueError('Media size mismatch')
        return bytes(content)

    def upload_operations(self):
        while True:
            with data_lock(self.data), app.connect() as db:
                pending = db.execute('SELECT id,body,digest FROM archive_outbox WHERE confirmed=0 ORDER BY id LIMIT 1').fetchone()
                if not pending:
                    ops = [json.loads(r[0]) for r in db.execute('SELECT payload FROM pocket_operations WHERE id NOT IN (SELECT operation_id FROM archive_uploaded) ORDER BY clock,device_id,sequence LIMIT 100')]
                    if not ops:
                        return
                    batch_id = uuid.uuid4().hex
                    batch = {'protocol': 1, 'id': batch_id, 'writerDeviceId': self.client.credentials['device_id'], 'createdAt': app.now(), 'operations': [{**o, 'uploaded': 0} for o in ops]}
                    while len(compact(batch).encode()) > 1048576 and len(batch['operations']) > 1:
                        batch['operations'].pop()
                    content = compact(batch).encode()
                    if len(content) > 1048576:
                        raise ValueError('Single operation exceeds batch limit')
                    pending = (batch_id, content, sha(content))
                    db.execute('INSERT INTO archive_outbox(id,body,digest) VALUES (?,?,?)', pending)
            batch_id, content, digest = pending
            self.client.request('batch/put', {'file_id': batch_id, 'batch_id': batch_id, 'digest': digest, 'data': base64.b64encode(content).decode()})
            row = self.client.request('batch/get', {'file_id': batch_id})
            if not row or sha(base64.b64decode(row['data'], validate=True)) != digest:
                raise ValueError('Batch upload readback failed')
            with data_lock(self.data), app.connect() as db:
                db.executemany('INSERT OR IGNORE INTO archive_uploaded VALUES (?)', [(o['id'],) for o in json.loads(content)['operations']])
                db.execute('UPDATE archive_outbox SET confirmed=1 WHERE id=?', (batch_id,))

    def round(self):
        confirmation = self.root / 'source-confirmed.json'
        if self.config.get('source_confirmed') is False and not confirmation.exists():
            state = self.client.request('status')
            checks = [check for check in state.get('migration_preparations', []) + state.get('migration_checks', []) if check.get('confirmed')]
            if not checks:
                durable(self.root / 'status.json', compact({'migration_waiting': True, 'error': '', 'checked_at': app.now()}).encode())
                return state['head']
            # Source/backup consent starts contribution; it is not a complete-data verification.
            backup = self.backup()
            durable(confirmation, compact({'confirmed_at': app.now(), 'checks': checks, 'desktop_backup': str(backup)}).encode())
            durable(self.root / 'status.json', compact({'migration_waiting': False, 'status': 'contributing', 'started_at': app.now(), 'error': ''}).encode())
        if self.config.get('primary', True) and not self.registered:
            self.client.request('archive/register', {k: self.identity[k] for k in ('archive_id', 'storage_id', 'primary_os')})
            self.registered = True
        self.upload_media()
        self.upload_operations()
        status = self.client.request('status')
        head = status['head']
        with app.connect() as db:
            after = db.execute('SELECT coalesce(max(seq),0) FROM archive_receipts').fetchone()[0]
        restore_marker = self.root / 'restore-replay.json'
        restoring = restore_marker.exists() and not json.loads(restore_marker.read_text('utf-8')).get('complete')
        if restoring:
            after = 0
        changes = []
        while after < head:
            page = self.client.request('changes', {'after': after, 'until': head, 'limit': 50})
            changes.extend(page['items'])
            if page['next_after'] is None:
                break
            after = page['next_after']
        incoming, receipts = [], []
        for change in changes:
            if change['kind'] == 'media':
                name, digest = change['file'], change['sha']
                if not app.ATTACHMENT.fullmatch(name):
                    raise ValueError('Invalid cloud media filename')
                path = self.data / 'attachments' / name
                content = path.read_bytes() if path.exists() else self.read_media(name, change['size'])
                if len(content) != change['size'] or sha(content) != digest:
                    raise ValueError('Media integrity check failed')
                if not path.exists():
                    durable(path, content)
            else:
                row = self.client.request('batch/get', {'file_id': change['id']})
                content = base64.b64decode(row['data'], validate=True)
                digest = change['digest']
                if len(content) > 1048576 or sha(content) != digest or row['batch_id'] != change['batch_id']:
                    raise ValueError('Raw batch integrity check failed')
                batch = json.loads(content)
                if batch.get('protocol') != 1 or batch.get('id') != change['batch_id'] or not isinstance(batch.get('operations'), list):
                    raise ValueError('Invalid batch protocol')
                for op in batch['operations']:
                    pocket_sync.validate_operation(op)
                incoming.extend(batch['operations'])
                durable(self.root / 'raw' / (str(change['seq']) + '-' + digest + '.json'), content)
            receipts.append((change['seq'], change['kind'], change['id'], digest))
        with data_lock(self.data):
            if incoming:
                for op in incoming:
                    for attachment in op['patch'].get('attachments', []):
                        if not app.ATTACHMENT.fullmatch(attachment['file']) or not (self.data / 'attachments' / attachment['file']).is_file():
                            raise ValueError('Referenced historical media not durable; archive ACK withheld')
                with app.connect() as db:
                    candidate, extensions = pocket_sync.preview(db, app.load(), incoming, app.validate_module, app.validate)
                app.save(candidate, remote=(incoming, extensions))
            # Business commit is replay-safe. Cursor receipts follow it and never precede it.
            with app.connect() as db:
                for receipt in receipts:
                    previous = db.execute('SELECT seq,kind,id,digest FROM archive_receipts WHERE seq=?', (receipt[0],)).fetchone()
                    if previous and previous != receipt:
                        raise ValueError('Archive receipt collision; durable ACK withheld')
                db.executemany('INSERT OR IGNORE INTO archive_receipts VALUES (?,?,?,?)', receipts)
                db.executemany('INSERT OR IGNORE INTO archive_uploaded VALUES (?)', [(o['id'],) for o in incoming])
            with app.connect() as db:
                if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise ValueError('SQLite integrity check failed; archive ACK withheld')
                rows = [{'seq': r[0], 'kind': r[1], 'id': r[2], 'digest': r[3]} for r in db.execute('SELECT seq,kind,id,digest FROM archive_receipts WHERE seq<=? ORDER BY seq', (head,))]
            with open(self.data / 'lifeos.sqlite', 'r+b') as stream:
                os.fsync(stream.fileno())
            proof = sha(compact(rows).encode())
            auto_ready = self.config.get('primary', True) and status['mode'] == 'staging' and len([p for p in status.get('migration_preparations', []) if p.get('auto_activate')]) >= 2 and len([c for c in status.get('migration_checks', []) if c.get('confirmed') and c.get('head') == head]) >= 2
            backup_digest = None
            if auto_ready:
                saved_file = self.root / 'migration-complete-backup.json'
                saved = json.loads(saved_file.read_text('utf-8')) if saved_file.exists() else {}
                if saved.get('head') != head or saved.get('proof') != proof:
                    full_backup = self.backup()
                    raw = (full_backup / 'manifest.json').read_bytes()
                    manifest = json.loads(raw)
                    media_rows = [{'file': f, 'sha': digest} for f, digest in sorted(manifest['media'].items())]
                    if len(media_rows) != status['manifest']['media_count'] or sha(compact(media_rows).encode()) != status['manifest']['media_digest']:
                        raise ValueError('Full archive backup lacks historical media; automatic activation withheld')
                    saved = {'head': head, 'proof': proof, 'digest': sha(raw), 'path': str(full_backup)}
                    durable(saved_file, compact(saved).encode())
                backup_digest = saved['digest']
        # No network wait holds the desktop's cross-process writer lock.
        if self.config.get('primary', True) and (backup_digest or not status.get('archive') or status['archive']['cursor'] != head or status['archive'].get('manifest') != proof):
            self.client.request('archive/ack', {'archive_id': self.identity['archive_id'], 'storage_id': self.identity['storage_id'], 'cursor': head, 'manifest': proof, **({'backup_digest': backup_digest} if backup_digest else {})})
        device_state = next((d for d in status.get('devices', []) if d['id'] == self.client.credentials['device_id']), None)
        if not device_state or device_state.get('cursor') != head:
            self.client.request('cursor/ack', {'cursor': head})
        if restoring:
            durable(restore_marker, compact({'complete': True, 'verified_head': head, 'completed_at': app.now()}).encode())
        if auto_ready and backup_digest:
            try:
                self.client.request('activate', {'automatic': True})
                status['mode'] = 'active'
            except (ValueError, OSError):
                pass  # A concurrent edit or transient outage will be retried next round.
        local_media = sum(1 for p in (self.data / 'attachments').glob('*') if p.is_file() and app.ATTACHMENT.fullmatch(p.name))
        durable(self.root / 'status.json', compact({'last_success': app.now(), 'head': head, 'unarchived_batches_at_checked_head': 0, 'media_integrity': 'sha256-verified-on-receipt', 'local_media_count': local_media, 'cloud_media_count': status.get('manifest', {}).get('media_count'), 'mode': status['mode'], 'primary': self.config.get('primary', True), 'error': ''}).encode())
        return head


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--backup', action='store_true')
    parser.add_argument('--init', action='store_true')
    parser.add_argument('--data-dir', type=Path)
    parser.add_argument('--endpoint', default='https://lifeos-sync.lifeos-pocket.workers.dev')
    parser.add_argument('--bootstrap-file', type=Path)
    parser.add_argument('--approve-pair', type=Path)
    parser.add_argument('--approve-stdin', action='store_true')
    parser.add_argument('--owner', action='store_true')
    parser.add_argument('--status', action='store_true')
    parser.add_argument('--activate', action='store_true')
    parser.add_argument('--export-recovery', type=Path)
    parser.add_argument('--password-file', type=Path)
    parser.add_argument('--pair-space')
    parser.add_argument('--pair-output', type=Path)
    parser.add_argument('--ordinary', action='store_true')
    parser.add_argument('--claim', action='store_true')
    parser.add_argument('--rebind-archive', action='store_true')
    parser.add_argument('--confirm-restore', action='store_true')
    args = parser.parse_args()
    if args.pair_space:
        if args.config.exists() or args.config.with_suffix('.vault').exists() or not args.data_dir or not args.pair_output:
            raise ValueError('Pairing requires new config/vault paths, --data-dir and --pair-output')
        if len(args.pair_space) != 64 or any(c not in 'abcdef0123456789' for c in args.pair_space):
            raise ValueError('Invalid Sync Space ID')
        credentials = new_credentials()
        credentials.update(space_id=args.pair_space, pair_id=secrets.token_hex(32), pair_secret=secrets.token_hex(32))
        config = {'data_dir': str(args.data_dir.resolve()), 'endpoint': args.endpoint.rstrip('/'), 'vault': str(args.config.with_suffix('.vault').resolve()), 'primary': not args.ordinary, 'poll_seconds': 45, 'python': sys.executable}
        save_vault(Path(config['vault']), credentials)
        durable(args.config, compact(config).encode())
        result = Client(config, credentials).request('pair/request', {'pair_id': credentials['pair_id'], 'secret': credentials['pair_secret'], 'public_key': credentials['public_key'], 'label': platform.node(), 'kind': 'archive'})
        durable(args.pair_output, compact({'spaceId': credentials['space_id'], 'pair_id': credentials['pair_id'], 'secret': credentials['pair_secret'], 'fingerprint': result['fingerprint'], 'expires': result['expires']}).encode())
        print('Pairing request saved; verify fingerprint on a management device and approve within ten minutes, then run --claim.')
        return
    if args.init:
        if not args.data_dir or not args.bootstrap_file:
            parser.error('--init requires --data-dir and --bootstrap-file')
        initialize_config(args.config, args.data_dir, args.endpoint, args.bootstrap_file)
        print('Sync space initialized in staging. No history uploaded; complete final Drive convergence and backup before starting agent.')
        return
    config = json.loads(args.config.read_text('utf-8'))
    if args.rebind_archive:
        if not args.confirm_restore or not config.get('primary'):
            raise ValueError('Archive rebind requires --confirm-restore and a primary configuration')
        credentials = json.loads(protect(Path(config['vault']).read_bytes(), True))
        client = Client(config, credentials)
        previous = client.request('status').get('archive')
        if not previous:
            raise ValueError('No existing logical archive to restore')
        data = Path(config['data_dir']).resolve()
        root = data / 'sync-archive'
        root.mkdir(parents=True, exist_ok=True)
        with data_lock(data):
            if (data / 'manifest.json').exists():
                manifest = json.loads((data / 'manifest.json').read_text('utf-8'))
                if manifest.get('space_id') != credentials['space_id'] or sha((data / 'lifeos.sqlite').read_bytes()) != manifest['database_sha256']:
                    raise ValueError('Restored backup space/database SHA mismatch')
                for file, digest in manifest['media'].items():
                    if not app.ATTACHMENT.fullmatch(file) or sha((data / 'attachments' / file).read_bytes()) != digest:
                        raise ValueError('Restored media SHA mismatch')
            with closing(sqlite3.connect(data / 'lifeos.sqlite')) as database:
                if database.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                    raise ValueError('Restored SQLite is invalid')
            pending_file = root / 'rebind-pending.json'
            candidate = json.loads(pending_file.read_text('utf-8')) if pending_file.exists() else {'archive_id': previous['archive_id'], 'storage_id': secrets.token_hex(32), 'primary_os': 'windows' if os.name == 'nt' else 'linux', 'data_dir': str(data), 'host': platform.node(), 'space_id': credentials['space_id'], 'device_id': credentials['device_id']}
            if candidate['space_id'] != credentials['space_id'] or candidate['device_id'] != credentials['device_id']:
                raise ValueError('Pending restore belongs to another identity')
            durable(pending_file, compact(candidate).encode())
            client.request('archive/rebind', {k: candidate[k] for k in ('archive_id', 'storage_id', 'primary_os', 'device_id')} | {'confirm_restore': True})
            identity_file = root / 'identity.json'
            if identity_file.exists():
                durable(root / ('identity-before-rebind-' + uuid.uuid4().hex + '.json'), identity_file.read_bytes())
            durable(identity_file, compact(candidate).encode())
            durable(root / 'restore-replay.json', compact({'complete': False, 'requested_at': app.now()}).encode())
        print('Archive explicitly rebound. Next run rechecks every raw batch and all media before acknowledging durability.')
        return
    if args.claim:
        credentials = json.loads(protect(Path(config['vault']).read_bytes(), True))
        Client(config, credentials).request('pair/claim', {'pair_id': credentials['pair_id'], 'secret': credentials['pair_secret']})
        credentials.pop('pair_secret', None)
        credentials.pop('pair_id', None)
        save_vault(Path(config['vault']), credentials)
        print('Device bound. Ordinary clients do not acknowledge authoritative archive durability.')
        return
    if args.status or args.activate or args.export_recovery:
        credentials = json.loads(protect(Path(config['vault']).read_bytes(), True))
        client = Client(config, credentials)
        if args.activate:
            client.request('activate')
        if args.export_recovery:
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM
            from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
            if not args.password_file or args.export_recovery.exists():
                raise ValueError('Provide --password-file and a new encrypted recovery output path')
            password = args.password_file.read_text('utf-8').strip()
            if len(password) < 12:
                raise ValueError('Recovery file password requires at least 12 characters')
            salt, iv = secrets.token_bytes(16), secrets.token_bytes(12)
            key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=600000).derive(password.encode())
            content = AESGCM(key).encrypt(iv, compact({'spaceId': credentials['space_id'], 'recovery': credentials['recovery']}).encode(), None)
            enc = lambda value: base64.b64encode(value).decode()
            durable(args.export_recovery, compact({'format': 'lifeos-sync-recovery-v1', 'iterations': 600000, 'salt': enc(salt), 'iv': enc(iv), 'data': enc(content)}).encode())
            print('Encrypted recovery file saved; password was not uploaded or logged.')
            return
        status_file = Path(config['data_dir']) / 'sync-archive' / 'status.json'
        print(compact({'space_id': credentials['space_id'], 'status': client.request('status'), 'local_archive': json.loads(status_file.read_text('utf-8')) if status_file.exists() else None}))
        return
    if args.approve_pair or args.approve_stdin:
        credentials = json.loads(protect(Path(config['vault']).read_bytes(), True))
        raw = sys.stdin.read(4097) if args.approve_stdin else args.approve_pair.read_text('utf-8')
        if len(raw) > 4096:
            raise ValueError('Pairing input exceeds limit')
        pair = json.loads(raw)
        if pair['spaceId'] != credentials['space_id']:
            raise ValueError('Pairing belongs to a different space')
        Client(config, credentials).request('pair/approve', {k: pair[k] for k in ('pair_id', 'secret', 'fingerprint')} | {'role': 'owner' if args.owner or pair.get('grant_owner') is True else 'member'})
        print('Device approved; finish binding on that device.')
        return
    agent = ArchiveAgent(config)
    if args.backup:
        print(agent.backup())
        return
    failures = 0
    while True:
        try:
            agent.round()
            failures = 0
        except Exception as error:
            failures += 1
            status_file = agent.root / 'status.json'
            try:
                previous = json.loads(status_file.read_text('utf-8'))
            except (ValueError, OSError):
                previous = {}
            durable(status_file, compact({**previous, 'error': str(error), 'failed_at': app.now()}).encode())
            if args.once:
                raise
        if args.once:
            return
        delay = min(300, 3 * 2 ** min(failures, 7)) if failures else config.get('poll_seconds', 45)
        time.sleep(delay * (.8 + secrets.randbelow(401) / 1000))


if __name__ == '__main__':
    main()
