"""Live acceptance helper: restricted to newly allocated E: temporary fixture directories."""
import argparse
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lifeos'))
import archive_agent as archive

parser = argparse.ArgumentParser()
parser.add_argument('--config', type=Path, required=True)
parser.add_argument('--action', required=True, choices=['init', 'status', 'pair/approve', 'activate', 'archive-once', 'inspect'])
parser.add_argument('--bootstrap-file', type=Path)
args = parser.parse_args()
root = args.config.resolve().parent
if root.parent != Path('E:/Codex/tmp').resolve() or not root.name.startswith('lifeos-live-sync-'):
    raise SystemExit('This acceptance helper only accepts isolated temporary fixtures')
value = json.loads(sys.stdin.read() or '{}')
if args.action == 'init':
    config = archive.initialize_config(args.config, root / 'data', 'https://lifeos-sync.lifeos-pocket.workers.dev', args.bootstrap_file)
    # Explicitly complete migration for a new synthetic fixture; never applies to real data.
    config['source_confirmed'] = True
    archive.durable(args.config, archive.compact(config).encode())
else:
    config = json.loads(args.config.read_text('utf-8'))
if Path(config['data_dir']).resolve() != root / 'data':
    raise SystemExit('Unexpected fixture data path')
credentials = json.loads(archive.protect(Path(config['vault']).read_bytes(), True))
client = archive.Client(config, credentials)
if args.action == 'init':
    result = {'space_id': credentials['space_id']}
elif args.action == 'archive-once':
    result = {'head': archive.ArchiveAgent(config, client).round()}
elif args.action == 'inspect':
    archive.app.DATA = Path(config['data_dir'])
    with archive.app.connect() as db:
        rows = db.execute('SELECT body FROM records WHERE title=? AND deleted=0', (value['title'],)).fetchall()
        result = {'count': len(rows), 'body_sha256': archive.sha(rows[0][0].encode()) if rows else None, 'integrity': db.execute('PRAGMA integrity_check').fetchone()[0]}
else:
    result = client.request(args.action, value)
print(json.dumps(result))
