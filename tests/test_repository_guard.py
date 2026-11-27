import importlib.util
import os
import subprocess
import sys
import tempfile
from pathlib import Path
import unittest
SCRIPT=Path(__file__).parents[1]/'tools/check_repository.py'
spec=importlib.util.spec_from_file_location('guard',SCRIPT)
guard=importlib.util.module_from_spec(spec); spec.loader.exec_module(guard)
class GuardTests(unittest.TestCase):
    def test_private_material(self):
        for name in ['private/mail.json','datasets/run.json','model.safetensors','.env','recording.wav','a.sqlite3']:
            self.assertTrue(guard.path_issues(name),name)
    def test_source_is_allowed(self):
        self.assertFalse(guard.path_issues('apps/desktop/src/main/ipc.ts'))
    def test_secret_detection_without_echo(self):
        token='gh'+'p_'+'a'*36
        findings=guard.content_issues(token.encode())
        self.assertTrue(findings);self.assertNotIn(token,str(findings))
    def test_binary_rejected(self):
        self.assertTrue(guard.content_issues(b'abc\x00def'))
    def test_placeholder_allowed(self):
        self.assertFalse(guard.content_issues(b'token=<operator-provided-token>'))
    def test_history_skips_local_stash(self):
        token='gh'+'p_'+'a'*36
        with tempfile.TemporaryDirectory() as tmp:
            # Drop the caller's GIT_* variables (a hook sets GIT_DIR) so git acts only on the throwaway repository.
            env={**{k:v for k,v in os.environ.items() if not k.startswith('GIT_')},'GIT_CONFIG_GLOBAL':os.devnull,'GIT_CONFIG_NOSYSTEM':'1','GIT_AUTHOR_NAME':'t','GIT_AUTHOR_EMAIL':'t@example.invalid','GIT_COMMITTER_NAME':'t','GIT_COMMITTER_EMAIL':'t@example.invalid'}
            def run(*args):subprocess.run(['git',*args],cwd=tmp,env=env,check=True,capture_output=True)
            def scan():return subprocess.run([sys.executable,str(SCRIPT),'--history'],cwd=tmp,env=env,capture_output=True,text=True)
            run('init','-q','-b','main')
            Path(tmp,'a.txt').write_text('clean\n');run('add','a.txt');run('commit','-q','-m','clean')
            Path(tmp,'a.txt').write_text(token+'\n');run('stash','push','-q')
            self.assertEqual(scan().returncode,0)
            run('stash','pop','-q');run('commit','-q','-am','leak')
            result=scan()
            self.assertEqual(result.returncode,1);self.assertIn('github-token',result.stdout);self.assertNotIn(token,result.stdout)
