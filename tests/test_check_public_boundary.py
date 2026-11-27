import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

TOOLS = Path(__file__).parents[1] / 'tools'
spec = importlib.util.spec_from_file_location('boundary', TOOLS / 'check_public_boundary.py')
boundary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundary)

# These tests use their own stand-in terms; the real list and its expected count must not leak in.
for _name in (boundary.TERMS_ENV, boundary.TERMS_FILE_ENV, boundary.TERM_COUNT_ENV):
    os.environ.pop(_name, None)

# Stand-in terms, so the real denied terms never appear in this repository.
TERM_LIST = 'machine name: Quokka-Lantern\nprivate repository name: velvet-orchard-vault\n'
TERMS = boundary.parse_terms(TERM_LIST)
OK = f'{boundary.ALLOWED_NAME} <{boundary.ALLOWED_EMAIL}>'


def terms_in(text):
    return [label for _, label in boundary.term_findings(text.encode(), TERMS)]


class TermList(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(TERMS, {b'quokkalantern': 'machine name', b'velvetorchardvault': 'private repository name'})

    def test_short_or_empty_lists_are_refused(self):
        for raw in ['', '# only a comment\n', 'x: abc12\n']:
            with self.assertRaises(boundary.TermsMissing):
                boundary.parse_terms(raw)

    def test_malformed_lists_are_refused(self):
        for raw in ['machine name: Quokka-Lantern private repository name: velvet-orchard-vault',
                    'a: Quokka-Lantern b: velvet-orch',
                    'a: Quokka-Lantern\\nvelvet',
                    'machine name: Quokka-Lantern\\nprivate repository name: velvet-orchard-vault',
                    'x: ' + 'a' * 60]:
            with self.assertRaises(boundary.TermsMissing, msg=raw[:30]):
                boundary.parse_terms(raw)

    def test_expected_count(self):
        os.environ[boundary.TERM_COUNT_ENV] = '3'
        try:
            with self.assertRaises(boundary.TermsMissing):
                boundary.parse_terms(TERM_LIST)
            os.environ[boundary.TERM_COUNT_ENV] = '2'
            self.assertEqual(len(boundary.parse_terms(TERM_LIST)), 2)
        finally:
            del os.environ[boundary.TERM_COUNT_ENV]

    def test_missing_list_fails_closed(self):
        env = {k: v for k, v in os.environ.items() if k != boundary.TERMS_ENV and not k.startswith('GIT_')}
        env[boundary.TERMS_FILE_ENV] = '/nonexistent/terms'
        result = subprocess.run(['python3', str(TOOLS / 'check_public_boundary.py'), '--tree'], env=env,
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('no term list', result.stderr)


class Terms(unittest.TestCase):
    def test_any_case_separator_or_surrounding_word(self):
        for text in ['Quokka-Lantern', 'quokka_lantern', 'QUOKKA LANTERN', 'quokka.lantern.example', 'QuokkaLantern',
                     'host: quokka-\nlantern', 'QuokkaLanternApp', 'quokkalantern2', 'myquokkalantern',
                     'velvet-orchard-vault.git', 'VelvetOrchardVaultDocs']:
            self.assertEqual(len(terms_in(text)), 1, text)

    def test_unrelated_text_and_longer_words_pass(self):
        for text in ['quokka and a lantern, apart', 'quokka lanterns', 'velvet orchard vaulted ceilings']:
            self.assertEqual(terms_in(text), [], text)

    def test_line_numbers_and_no_echo(self):
        found = boundary.term_findings(b'one\ntwo\nsee Quokka-Lantern here\n', TERMS)
        self.assertEqual(found, [(3, 'machine name')])
        self.assertNotIn('Quokka', str(found))


class Layout(unittest.TestCase):
    def test_public_layout_passes(self):
        for name in ['README.md', 'LICENSE', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/pipeline.ts',
                     'apps/desktop/package.json', 'apps/desktop/tests/unit/a.test.ts',
                     '.github/workflows/checks.yml', '.githooks/pre-push', 'tools/check_repository.py',
                     'tests/test_repository_guard.py']:
            self.assertEqual(boundary.layout_findings(name), [], name)

    def test_everything_else_fails_in_any_case(self):
        for name in ['research/x.py', 'Research/x.py', 'notes/plan.md', 'Notes/Secret-Plans/1.md',
                     'apps/other/Package.swift', 'Apps/Desktop/src/x.ts', 'apps/desktop/reference/plan.md',
                     'apps/desktop/notes.md', 'tools/other_tool.py', 'tests/test_other.py', 'SECURITY.md', 'notes.md']:
            self.assertIn('path outside the public layout', boundary.layout_findings(name), name)

    def test_app_code_types_pass(self):
        for folder in ['apps/desktop/src/', 'apps/desktop/tests/']:
            for suffix in ['.ts', '.tsx', '.css', '.html', '.cjs', '.json']:
                self.assertEqual(boundary.layout_findings(folder + 'part/name' + suffix), [], folder + suffix)

    def test_app_source_and_tests_hold_code_only(self):
        for name in ['apps/desktop/src/reference/plan.md', 'apps/desktop/tests/notes.txt', 'apps/desktop/src/a.swift',
                     'apps/desktop/src/data.jsonl', 'apps/desktop/src/a.TS', 'apps/desktop/tests/README',
                     'apps/desktop/src/.DS_Store']:
            self.assertIn('file type outside the public layout', boundary.layout_findings(name), name)

    def test_private_dirs_secret_files_and_submodules(self):
        self.assertIn('private data path', boundary.layout_findings('apps/desktop/src/PRIVATE/a.ts'))
        self.assertIn('private data path', boundary.layout_findings('apps/desktop/tests/datasets/a.json'))
        for name in ['apps/desktop/src/.env', 'apps/desktop/src/.env.test', 'apps/desktop/src/prod.env',
                     'apps/desktop/src/.npmrc', 'apps/desktop/src/.envrc', 'apps/desktop/src/id_ed25519']:
            self.assertIn('secret file', boundary.layout_findings(name), name)
        self.assertIn('submodule', boundary.layout_findings('apps/desktop/src/vendor', b'160000'))


class Content(unittest.TestCase):
    def test_secret_patterns_come_from_check_repository(self):
        token = 'gh' + 'p_' + 'a' * 36
        found = boundary.content_findings('x.ts', f'x = "{token}"'.encode(), TERMS)
        self.assertEqual(found, [(1, 'secret pattern: github-token')])
        self.assertNotIn(token, str(found))

    def test_lfs(self):
        pointer = b'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n'
        self.assertIn((1, 'Git LFS pointer'), boundary.content_findings('apps/desktop/a.bin', pointer, TERMS))
        self.assertIn((1, 'Git LFS filter'),
                      boundary.content_findings('.gitattributes', b'*.bin filter=lfs diff=lfs\n', TERMS))

    def test_dangling_pointers(self):
        paths = {'apps/desktop/README.md', 'apps/desktop/src/main/ipc.ts', 'README.md'}
        text = (b'see `src/main/ipc.ts` and ../../README.md and .vite/build/main.cjs and `apps/desktop/src/`\n'
                b'but also `research/tests/test_x.py`\n[doc](../../notes/plans/plan.md)\n'
                b'and the folder `notes/plans/`, a picture notes/a/shot.png\n')
        found = boundary.pointer_findings('apps/desktop/README.md', text, paths)
        self.assertEqual(found, [(2, 'points to a file that is not in this repository'),
                                 (3, 'points to a file that is not in this repository'),
                                 (4, 'points to a file that is not in this repository'),
                                 (4, 'points to a folder that is not in this repository')])

    def test_messages_may_name_any_path_in_history(self):
        paths = {'apps/desktop/src/old.ts'}
        text = b'Remove apps/desktop/src/old.ts; see research/plan.md\n'
        found = boundary.pointer_findings('', text, paths, message=True)
        self.assertEqual([line for line, _ in found], [1])

    def test_host_details(self):
        for text in [b'cd /Users/someone/code', b'ssh 192.168.1.20', b'host 10.0.0.7', b'box.local:22', b'node.ts.net']:
            self.assertTrue(boundary.host_findings('apps/desktop/src/a.ts', text), text)
        for text in [b'127.0.0.1:30113', b'/home/runner/work', b'/Users/<you>/code', b'name.invalid', b'$HOME/x']:
            self.assertEqual(boundary.host_findings('apps/desktop/src/a.ts', text), [], text)

    def test_urls_and_packages_are_not_pointers(self):
        text = b'https://example.com/a/b.md and @scope/pkg/x.js and react-dom/client and "$TMP/base/x.py"\n'
        self.assertEqual(boundary.pointer_findings('apps/desktop/a.ts', text, set()), [])


class Identity(unittest.TestCase):
    def check(self, line):
        report = boundary.Report(TERMS)
        report.identity('c', 'author', line)
        return sorted(report.findings)

    def test_only_the_allowed_identity_passes(self):
        self.assertEqual(self.check(f'author {OK} 1700000000 +0000'.encode()), [])
        self.assertEqual(len(self.check(b'author Someone <fakoli@users.noreply.github.com> 1700000000 +0000')), 1)
        found = self.check(b'author fakoli <someone@example.com> 1700000000 +0000')
        self.assertEqual(len(found), 1)
        self.assertNotIn('someone@example.com', found[0])


class Repo(unittest.TestCase):
    """End to end against throwaway repositories with their own copy of the tools."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / 'repo'
        self.repo.mkdir()
        # Drop the caller's GIT_* variables (a hook sets GIT_DIR) so git acts only on the throwaway repository.
        inherited = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
        self.env = {**inherited, boundary.TERMS_ENV: TERM_LIST, 'GIT_CONFIG_GLOBAL': os.devnull,
                    'GIT_CONFIG_NOSYSTEM': '1', 'GIT_AUTHOR_NAME': 'fakoli', 'GIT_AUTHOR_EMAIL': boundary.ALLOWED_EMAIL,
                    'GIT_COMMITTER_NAME': 'fakoli', 'GIT_COMMITTER_EMAIL': boundary.ALLOWED_EMAIL}
        self.git('init', '-q', '-b', 'main')
        (self.repo / 'tools').mkdir()
        for name in ['check_public_boundary.py', 'check_repository.py']:
            (self.repo / 'tools' / name).write_bytes((TOOLS / name).read_bytes())
        (self.repo / 'README.md').write_text('hello\n')

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args, env=None, input=None):
        return subprocess.run(['git', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c',
                               'core.hooksPath=/dev/null', *args], cwd=self.repo, check=True, capture_output=True,
                              env=env or self.env, input=input).stdout

    def commit(self, message='change', **ident):
        env = {**self.env, **ident}
        self.git('add', '-A', env=env)
        self.git('commit', '-q', '--allow-empty', '-m', message, env=env)

    def run_tool(self, *args, env=None):
        result = subprocess.run(['python3', str(self.repo / 'tools/check_public_boundary.py'), *args], cwd=self.repo,
                                capture_output=True, text=True, env=env or self.env)
        return result.returncode, result.stdout + result.stderr

    def test_clean_history_passes(self):
        self.commit()
        code, out = self.run_tool()
        self.assertEqual(code, 0, out)

    def test_removed_private_path_and_foreign_identity_stay_in_history(self):
        (self.repo / 'pipeline').mkdir()
        (self.repo / 'pipeline' / 'x.py').write_text('print(1)\n')
        self.commit(GIT_AUTHOR_EMAIL='someone@example.com', GIT_COMMITTER_NAME='Someone')
        (self.repo / 'pipeline' / 'x.py').unlink()
        self.commit()
        self.assertEqual(self.run_tool('--tree')[0], 0)
        code, out = self.run_tool('--history')
        self.assertEqual(code, 1)
        self.assertIn('pipeline/x.py: path outside the public layout', out)
        self.assertIn(f'author email is not {boundary.ALLOWED_EMAIL}', out)
        self.assertIn(f'committer name is not {boundary.ALLOWED_NAME}', out)
        self.assertNotIn('someone@example.com', out)

    def test_term_in_a_file_name_is_found_and_withheld(self):
        (self.repo / 'tools' / 'quokka-lantern-notes.md').write_text('x\n')
        self.commit()
        code, out = self.run_tool('--tree')
        self.assertEqual(code, 1)
        self.assertIn('name contains a denied term', out)
        self.assertNotIn('quokka', out.lower())

    def test_term_in_an_author_name(self):
        self.commit(GIT_AUTHOR_NAME='Quokka Lantern')
        code, out = self.run_tool('--history')
        self.assertEqual(code, 1)
        self.assertIn('author name is not fakoli', out)
        self.assertIn('header', out)
        self.assertNotIn('quokka', out.lower())

    def test_staged_content_and_identity(self):
        self.commit()
        (self.repo / 'README.md').write_text('from velvet orchard vault\n')
        self.git('add', '-A')
        env = {**self.env, 'GIT_AUTHOR_EMAIL': 'someone@example.com'}
        code, out = self.run_tool('--staged', env=env)
        self.assertEqual(code, 1)
        self.assertIn('staged README.md:1: private repository name', out)
        self.assertIn('pending commit: author email is not', out)

    def test_message_file_scans_comment_lines(self):
        message = Path(self.tmp.name) / 'MSG'
        message.write_text('Build notes\n# from Quokka-Lantern\n')
        code, out = self.run_tool('--message-file', str(message))
        self.assertEqual(code, 1)
        self.assertIn('commit message:2: machine name', out)

    def test_message_file_ignores_the_verbose_diff(self):
        message = Path(self.tmp.name) / 'MSG'
        message.write_text('Remove a leaked name\n# ------------------------ >8 ------------------------\n'
                           '-host quokka-lantern\n')
        code, out = self.run_tool('--message-file', str(message))
        self.assertEqual(code, 0, out)

    def test_stash_is_not_part_of_the_history(self):
        self.commit()
        (self.repo / 'README.md').write_text('from quokka lantern\n')
        self.git('stash', '-q')
        code, out = self.run_tool('--history')
        self.assertEqual(code, 0, out)

    def test_tags_must_lead_to_commits_and_are_scanned(self):
        self.commit()
        blob = self.git('hash-object', '-w', '--stdin', input=b'payload\n').decode().strip()
        self.git('tag', 'blob-tag', blob)
        self.git('tag', '-a', 'inner', '-m', 'from quokka lantern')
        self.git('tag', '-a', 'outer', 'inner', '-m', 'wrapper')
        code, out = self.run_tool('--history')
        self.assertEqual(code, 1)
        self.assertIn('leads to a blob, not a commit', out)
        self.assertIn('message:1: machine name', out)

    def test_signed_and_mergetag_headers_are_refused(self):
        self.commit()
        tree = self.git('rev-parse', 'HEAD^{tree}').decode().strip()
        raw = (f'tree {tree}\nauthor {OK} 1700000000 +0000\ncommitter {OK} 1700000000 +0000\n'
               'gpgsig -----BEGIN SSH SIGNATURE-----\n x\n -----END SSH SIGNATURE-----\n\nsigned\n').encode()
        oid = self.git('hash-object', '-t', 'commit', '-w', '--stdin', input=raw).decode().strip()
        self.git('update-ref', 'refs/heads/signed', oid)
        code, out = self.run_tool('--history')
        self.assertEqual(code, 1)
        self.assertIn('carries a gpgsig header', out)

    def test_submodule_entries_are_refused(self):
        self.commit()
        head = self.git('rev-parse', 'HEAD').decode().strip()
        self.git('update-index', '--add', '--cacheinfo', f'160000,{head},vendor')
        code, out = self.run_tool('--staged')
        self.assertEqual(code, 1)
        self.assertIn('vendor: submodule', out)

    def test_shallow_clone_cannot_pass(self):
        self.commit()
        self.commit()
        clone = Path(self.tmp.name) / 'shallow'
        subprocess.run(['git', 'clone', '-q', '--depth', '1', f'file://{self.repo}', str(clone)], check=True,
                       env=self.env, capture_output=True)
        result = subprocess.run(['python3', str(clone / 'tools/check_public_boundary.py'), '--history'], cwd=clone,
                                capture_output=True, text=True, env=self.env)
        self.assertEqual(result.returncode, 2)
        self.assertIn('shallow', result.stderr)

    def test_push_ref_names(self):
        result = subprocess.run(['python3', str(self.repo / 'tools/check_public_boundary.py'), '--push-refs'],
                                cwd=self.repo, capture_output=True, text=True, env=self.env,
                                input=f'refs/heads/main {"0" * 40} refs/heads/quokka-lantern {"0" * 40}\n')
        self.assertEqual(result.returncode, 1)
        self.assertIn('push ref <name withheld', result.stdout)

    def test_root_option_scans_another_checkout(self):
        self.commit()
        code, out = subprocess.run(['python3', str(TOOLS / 'check_public_boundary.py'), '--root', str(self.repo)],
                                   capture_output=True, text=True, env=self.env).returncode, ''
        self.assertEqual(code, 0)


if __name__ == '__main__':
    unittest.main()
