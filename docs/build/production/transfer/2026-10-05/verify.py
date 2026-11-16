#!/usr/bin/env python3
"""Read-only transfer integrity check. This does not execute acceptance tests."""
from pathlib import Path
import hashlib
import json
import os
import subprocess
import sys

directory = Path(__file__).resolve().parent
repository = directory.parents[4]
manifest = json.loads((directory / 'SHA256-MANIFEST.json').read_text())
failures = []
for relative, expected in manifest['files'].items():
    path = directory / relative
    if path.is_symlink() or directory not in path.resolve().parents or not path.is_file():
        failures.append(relative + ': missing or unsafe path')
        continue
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        failures.append(relative + ': hash mismatch')
packets = json.loads((directory / 'PACKETS.json').read_text())
for packet in packets['packets']:
    for field in ['patch', 'freeze']:
        path = directory / packet[field]
        if hashlib.sha256(path.read_bytes()).hexdigest() != packet[field + 'Sha256']:
            failures.append(packet['id'] + ': ' + field + ' binding mismatch')
archive = json.loads((directory / 'HANDOFF-ARCHIVE-INDEX.json').read_text())
digest_cache = {}
for document in archive['documents']:
    relative = document['included']
    if relative not in manifest['files']:
        failures.append(relative + ': unbound archive entry')
        continue
    if relative not in digest_cache:
        digest_cache[relative] = hashlib.sha256((directory / relative).read_bytes()).hexdigest()
    if digest_cache[relative] != document.get('storedSha256', document['sha256']):
        failures.append(relative + ': archive projection binding mismatch')
environment = dict(os.environ, GIT_OPTIONAL_LOCKS='0')
base = packets['baseCommit']
tree = subprocess.run(['git', 'rev-parse', base + '^{tree}'], cwd=repository,
                      env=environment, capture_output=True, text=True)
if tree.returncode or tree.stdout.strip() != packets['baseTree']:
    failures.append('exact product checkpoint tree unavailable or mismatched')
ancestor = subprocess.run(['git', 'merge-base', '--is-ancestor', base, 'HEAD'],
                          cwd=repository, env=environment, capture_output=True)
if ancestor.returncode:
    failures.append('product checkpoint is not in current HEAD ancestry')
if failures:
    print('\n'.join(failures), file=sys.stderr)
    sys.exit(1)
print(f"Transfer integrity passed: {len(manifest['files'])} files, {len(packets['packets'])} pending packets, exact product ancestry. Acceptance tests remain separate.")
