"""Validate first-publication rollback; apply only with --apply. Keep browser data."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request

release = Path(__file__).resolve().parent
meta = json.loads((release / 'metadata.json').read_text())
state = json.loads((release / 'deploy-state.json').read_text())
main = Path('/etc/caddy/Caddyfile')
site = Path('/etc/caddy/rodoslovnaya.caddy')
backup = Path(state['backup']) / 'Caddyfile.before'
digest = lambda data: hashlib.sha256(data).hexdigest()
assert digest(main.read_bytes()) == state['mainAfterSha256'], 'Caddy changed: reconcile, do not overwrite'
assert digest(site.read_bytes()) == state['siteConfigSha256'], 'Site configuration changed'
assert digest(backup.read_bytes()) == state['mainBeforeSha256']
assert all(digest(Path(p).read_bytes()) == h for p, h in state['importsBefore'].items())
adapt = subprocess.run(['caddy', 'adapt', '--config', str(main), '--adapter', 'caddyfile'], check=True, capture_output=True)
assert json.loads(adapt.stdout) == json.load(urllib.request.urlopen('http://127.0.0.1:2019/config/'))
candidate = Path('/etc/caddy/Caddyfile.rodoslovnaya-rollback')
assert not candidate.exists()
before = main.stat()
current = main.read_bytes()
try:
    shutil.copy2(backup, candidate)
    os.chown(candidate, before.st_uid, before.st_gid)
    subprocess.run(['caddy', 'validate', '--config', str(candidate), '--adapter', 'caddyfile'], check=True)
    if '--apply' in sys.argv:
        assert main.read_bytes() == current
        assert all(digest(Path(p).read_bytes()) == h for p, h in state['importsBefore'].items())
        os.replace(candidate, main)
        try:
            subprocess.run(['systemctl', 'reload', 'caddy'], check=True)
        except Exception:
            if digest(main.read_bytes()) == state['mainBeforeSha256']:
                recovery = main.with_name('Caddyfile.rodoslovnaya-recovery')
                assert not recovery.exists()
                recovery.write_bytes(current)
                os.chmod(recovery, before.st_mode & 0o7777)
                os.chown(recovery, before.st_uid, before.st_gid)
                os.replace(recovery, main)
                subprocess.run(['systemctl', 'reload', 'caddy'], check=True)
            raise
        assert digest(main.read_bytes()) == state['mainBeforeSha256'], 'Concurrent configuration change'
        assert digest(site.read_bytes()) == state['siteConfigSha256']
        site.unlink()
        print('Rolled back site publication; application release and browser data preserved.')
    else:
        print('Rollback candidate valid; live configuration unchanged. Use --apply only after reviewing impact.')
finally:
    if candidate.exists() and digest(candidate.read_bytes()) == state['mainBeforeSha256']:
        candidate.unlink()
