"""Package only the standalone Pocket assets, never the desktop backend or user data."""
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
source = ROOT / 'lifeos/static/pocket'
release = ROOT / 'release'
site = release / 'site'
expected = {'app.css','app.js','apple-touch-icon.png','icon-192.png','icon-512.png','icon.svg','index.html','manifest.webmanifest','sw.js'}
if {f.name for f in source.iterdir() if f.is_file()} != expected:
    raise SystemExit('Pocket build is missing assets or contains unexpected files; run npm run build first.')
landing = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=/pocket/"><title>LifeOS Pocket</title><a href="/pocket/">打开 LifeOS Pocket</a></html>'
headers = "/pocket/*\n  Cross-Origin-Opener-Policy: same-origin-allow-popups\n  Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; script-src 'self' https://accounts.google.com/gsi/client; frame-src https://accounts.google.com; connect-src 'self' https://accounts.google.com https://www.googleapis.com https://docs.googleapis.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'\n/pocket/sw.js\n  Cache-Control: no-cache\n"
payload = {'index.html':landing.encode('utf8'), '_headers':headers.encode('utf8')}
payload.update({'pocket/'+name:(source/name).read_bytes() for name in sorted(expected)})
for name, raw in payload.items():
    target = site / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(raw)
archive = release / 'lifeos-pocket-web.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
    for name, raw in payload.items():
        z.writestr(name,raw)
with zipfile.ZipFile(archive) as z:
    assert set(z.namelist()) == set(payload)
    assert z.testzip() is None
    assert all(z.read(name)==raw for name,raw in payload.items())
print(str(archive))
print(f'{len(payload)} static files; {archive.stat().st_size} bytes; no database, backup, backend or credentials included.')
