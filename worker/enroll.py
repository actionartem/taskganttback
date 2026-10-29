#!/usr/bin/env python3
"""Read {itsm_token, relay_token} from secure stdin and seal the laptop vault."""
import json
import os
from pathlib import Path
import sys
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

os.umask(0o077)
base = Path.home() / '.local/share/simpletracker-itsm-worker'
keydir = Path.home() / '.config/simpletracker-itsm-worker'
base.mkdir(mode=0o700, parents=True, exist_ok=True)
keydir.mkdir(mode=0o700, parents=True, exist_ok=True)
keyfile, vault = keydir / 'vault.key', base / 'credentials.vault'
if keyfile.exists() or vault.exists():
    raise SystemExit('Existing credentials: stop worker and explicitly arrange rotation before enrollment')
config = json.load(sys.stdin)
if set(config) != {'itsm_token', 'relay_token'} or not all(isinstance(v, str) and len(v) >= 32 for v in config.values()):
    raise SystemExit('Invalid credential input')
key = AESGCM.generate_key(bit_length=256)
nonce = os.urandom(12)
keyfile.write_bytes(key)
vault.write_bytes(nonce + AESGCM(key).encrypt(nonce, json.dumps(config).encode(), b'simpletracker-itsm-worker-v1'))
print('Encrypted vault created; credentials were not written as plaintext')
