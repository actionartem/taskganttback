import importlib.util
from pathlib import Path
import tempfile
import os
import json
import unittest
from unittest.mock import patch
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

spec = importlib.util.spec_from_file_location('worker', Path(__file__).with_name('worker.py'))
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)
URL = 'https://api.itsm.mos.ru/v1/requests/27787457'

class Response:
    status_code = 401
    headers = {'Link': '<' + URL + '/notes?page=2>; rel="next"'}
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def iter_content(self, chunk_size): yield b'{"message":"permission denied"}'

class WorkerTests(unittest.TestCase):
    def test_allowlist(self):
        for u in [URL, URL+'/notes?page=2&per_page=100', URL+'/cis']:
            self.assertTrue(w.allowed_url(u))
        for u in [URL.replace('https:', 'http:'),URL.replace('api.itsm.mos.ru','evil.invalid'),URL+'/unknown',URL+'#',URL+'?page=0',URL+'?per_page=101',URL+'?page=1&page=2',URL+'?other=2',URL+'/notes/../../users',URL.replace('https://','https://x@'),URL+'\\x',URL+'?page=1\n']:
            self.assertFalse(w.allowed_url(u),u)

    def test_fixed_get_tls_no_redirects_separate_credentials_and_status_link_bytes(self):
        with patch.object(w.requests,'Session') as session:
            client=session.return_value.__enter__.return_value
            client.get.return_value=Response()
            result=w.read_provider({'url':URL,'nonce':'nonce','max_bytes':w.MAX_BYTES},'provider-secret',10)
            args,kwargs=client.get.call_args
            self.assertEqual(args,(URL,))
            self.assertTrue(kwargs['verify'])
            self.assertFalse(kwargs['allow_redirects'])
            self.assertFalse(client.trust_env)
            self.assertEqual(kwargs['headers']['X-4me-Account'],'echd')
            self.assertEqual(kwargs['headers']['Authorization'],'Bearer provider-secret')
            self.assertEqual(result['status'],401)
            self.assertEqual(result['link'],Response.headers['Link'])
            self.assertEqual(w.base64.b64decode(result['body']),b'{"message":"permission denied"}')
            self.assertNotIn('provider-secret',str(result))

    def test_invalid_and_expired_jobs_never_touch_network(self):
        with patch.object(w.requests,'Session') as session:
            for job,ttl in [({'url':'https://evil.invalid','nonce':'n','max_bytes':w.MAX_BYTES},10),({'url':URL,'nonce':'n','max_bytes':w.MAX_BYTES},0),({'url':URL,'nonce':'n','max_bytes':w.MAX_BYTES+1},10)]:
                self.assertEqual(w.read_provider(job,'s',ttl)['error'],'invalid_response')
            session.assert_not_called()

    def test_bounds_and_network_errors(self):
        with patch.object(w.requests,'Session') as session:
            client=session.return_value.__enter__.return_value
            client.get.side_effect=w.requests.Timeout()
            job={'url':URL,'nonce':'n','max_bytes':w.MAX_BYTES}
            self.assertEqual(w.read_provider(job,'s',10)['error'],'timeout')
            client.get.side_effect=w.requests.ConnectionError('private provider text')
            self.assertEqual(w.read_provider(job,'s',10)['error'],'network')
            client.get.side_effect=None
            response=Response();response.iter_content=lambda chunk_size: iter([b'x'*(w.MAX_BYTES+1)])
            client.get.return_value=response
            self.assertEqual(w.read_provider(job,'s',10)['error'],'too_large')

    def test_encrypted_vault_authentication_and_loading_from_systemd_credential(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);key=AESGCM.generate_key(bit_length=256);nonce=os.urandom(12)
            config={'relay_token':'r'*48,'itsm_token':'p'*80}
            sealed=nonce+AESGCM(key).encrypt(nonce,json.dumps(config).encode(),b'simpletracker-itsm-worker-v1')
            (root/'relay-vault-key').write_bytes(key);(root/'vault').write_bytes(sealed)
            self.assertNotIn(config['itsm_token'].encode(),sealed)
            with patch.dict(os.environ,{'CREDENTIALS_DIRECTORY':d,'ITSM_WORKER_VAULT':str(root/'vault')}):
                self.assertEqual(w.load_config(),config)
                (root/'vault').write_bytes(sealed[:-1]+bytes([sealed[-1]^1]))
                with self.assertRaises(Exception):w.load_config()

if __name__=='__main__':unittest.main()
