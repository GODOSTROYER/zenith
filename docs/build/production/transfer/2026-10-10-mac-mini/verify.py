#!/usr/bin/env python3
"""Read-only handoff integrity and ancestry verification. Never apply or run packets."""
import hashlib
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
manifest = json.loads((HERE / 'manifest.json').read_text())
failures = []
for entry in manifest['files']:
    path = (HERE / entry['path']).resolve()
    if not path.is_relative_to(HERE) or not path.is_file():
        failures.append('missing or unsafe path: ' + entry['path'])
        continue
    data = path.read_bytes()
    if len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
        failures.append('hash mismatch: ' + entry['path'])
base = manifest['baseCommit']
if subprocess.run(['git', 'merge-base', '--is-ancestor', base, 'HEAD'], cwd=ROOT).returncode:
    failures.append('transfer base is not in checkout ancestry')
for name, expected in manifest['candidatePreimages'].items():
    old = subprocess.run(['git', 'show', base + ':' + name], cwd=ROOT, capture_output=True)
    if old.returncode or hashlib.sha256(old.stdout).hexdigest() != expected:
        failures.append('base preimage mismatch: ' + name)
    current = ROOT / name
    if current.is_file() and hashlib.sha256(current.read_bytes()).hexdigest() != expected:
        print('RECONCILE newer current source before applying candidate: ' + name)
if failures:
    raise SystemExit('\n'.join(failures))
print(f"PASS: {len(manifest['files'])} transfer files, base ancestry and recorded preimages. No candidate applied or executed.")
