#!/usr/bin/env python3
"""Fixed-host MOS ITSM reader. Secrets are decrypted only in process memory."""
import base64
import concurrent.futures
import json
import logging
import os
from pathlib import Path
import re
import sys
import time
from urllib.parse import urlsplit, parse_qsl

import requests
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

API = 'https://api.simpletracker.ru/integrations/itsm-relay'
SECTIONS = frozenset('notes audit note_attachments affected_slas cis grouped_requests inbound_emails knowledge_articles automation_rules sprint_backlog_items tags watches'.split())
MAX_BYTES = 12 * 1024 * 1024
LOG = logging.getLogger('itsm-worker')


def allowed_url(value):
    if not isinstance(value, str) or len(value) > 2048 or any(c in value for c in ['\\', '\r', '\n', '\t', '#']):
        return False
    u = urlsplit(value)
    if u.scheme != 'https' or u.netloc != 'api.itsm.mos.ru' or u.fragment:
        return False
    m = re.fullmatch(r'/v1/requests/[1-9]\d{0,14}(?:/([a-z_]+))?', u.path)
    if not m or (m[1] and m[1] not in SECTIONS):
        return False
    seen = set()
    for key, val in parse_qsl(u.query, keep_blank_values=True):
        if key in seen or key not in {'page', 'per_page'} or not re.fullmatch(r'[1-9]\d{0,5}', val) or (key == 'per_page' and int(val) > 100):
            return False
        seen.add(key)
    return True


def read_provider(job, token, ttl):
    result = {'nonce': job['nonce']}
    if not allowed_url(job.get('url')) or job.get('max_bytes') != MAX_BYTES or ttl <= 0:
        return {**result, 'error': 'invalid_response'}
    deadline = time.monotonic() + min(ttl, 8.5)
    try:
        # No environment proxies, cookies, redirects or ambient credentials.
        with requests.Session() as session:
            session.trust_env = False
            with session.get(job['url'], headers={'Authorization': 'Bearer ' + token,
                             'X-4me-Account': 'echd', 'Accept': 'application/json',
                             'Cache-Control': 'no-cache'}, timeout=(3, 6),
                             allow_redirects=False, stream=True, verify=True) as response:
                length, chunks = 0, []
                for chunk in response.iter_content(chunk_size=65536):
                    length += len(chunk)
                    if length > MAX_BYTES:
                        return {**result, 'error': 'too_large'}
                    if time.monotonic() > deadline:
                        return {**result, 'error': 'timeout'}
                    chunks.append(chunk)
                link = response.headers.get('Link')
                if link and (len(link) > 16384 or '\r' in link or '\n' in link):
                    return {**result, 'error': 'invalid_response'}
                return {**result, 'status': response.status_code, 'link': link,
                        'body': base64.b64encode(b''.join(chunks)).decode('ascii')}
    except requests.Timeout:
        return {**result, 'error': 'timeout'}
    except requests.RequestException:
        return {**result, 'error': 'network'}


def relay_session(key):
    s = requests.Session()
    s.trust_env = False
    s.headers['X-ITSM-Relay-Token'] = key
    return s


def perform(job, config, server_time):
    started = time.monotonic()
    ttl = min(11, (job['expires_at'] - server_time) / 1000)
    payload = read_provider(job, config['itsm_token'], ttl - 1)
    if time.monotonic() - started >= ttl:
        LOG.warning('job expired before delivery')
        return
    try:
        with relay_session(config['relay_token']) as session:
            response = session.post(API + '/jobs/' + job['id'] + '/result', json=payload,
                                    timeout=(3, 8), allow_redirects=False)
            if response.status_code == 204:
                # No numbers, URLs, payloads, comments or credentials in logs.
                if 'error' in payload:
                    LOG.warning('provider error: %s', payload['error'])
                else:
                    LOG.info('job delivered; upstream HTTP %d', payload['status'])
            else:
                LOG.warning('result rejected; HTTP %d', response.status_code)
    except requests.RequestException:
        LOG.warning('result delivery unavailable')


def load_config():
    directory = Path(os.environ['CREDENTIALS_DIRECTORY'])
    key = (directory / 'relay-vault-key').read_bytes()
    sealed = Path(os.environ['ITSM_WORKER_VAULT']).read_bytes()
    config = json.loads(AESGCM(key).decrypt(sealed[:12], sealed[12:], b'simpletracker-itsm-worker-v1'))
    if not all(isinstance(config.get(k), str) and len(config[k]) >= 32 for k in ['itsm_token', 'relay_token']):
        raise ValueError('invalid credential')
    return config


def run(config):
    LOG.info('worker started; fixed-host GET only; concurrency=4')
    failures = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool, relay_session(config['relay_token']) as session:
        active = set()
        while True:
            active = {f for f in active if not f.done()}
            if len(active) >= 4:
                concurrent.futures.wait(active, timeout=1, return_when=concurrent.futures.FIRST_COMPLETED)
                continue
            try:
                response = session.get(API + '/jobs', params={'capacity': 4 - len(active)},
                                       timeout=(5, 27), allow_redirects=False)
                if response.status_code != 200:
                    raise RuntimeError('HTTP ' + str(response.status_code))
                # Poll metadata is tiny and contains no provider data.
                if len(response.content) > 65536:
                    raise ValueError('oversized poll')
                data = response.json()
                if failures:
                    LOG.info('connection restored')
                failures = 0
                jobs = data['jobs']
                if not isinstance(jobs, list) or len(jobs) > 4 - len(active):
                    raise ValueError('invalid batch')
                for job in jobs:
                    if not re.fullmatch(r'[0-9a-f-]{36}', job.get('id', '')) or not re.fullmatch(r'[0-9a-f]{48}', job.get('nonce', '')):
                        raise ValueError('invalid job')
                    active.add(pool.submit(perform, job, config, data['server_time']))
            except (requests.RequestException, ValueError, KeyError, TypeError, RuntimeError):
                failures += 1
                if failures == 1 or failures % 12 == 0:
                    LOG.warning('relay connection unavailable; retrying')
                time.sleep(min(15, 2 ** min(failures, 4)))


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(levelname)s %(message)s')
    try:
        run(load_config())
    except Exception as error:
        LOG.error('worker stopped: %s', type(error).__name__)
        sys.exit(1)
