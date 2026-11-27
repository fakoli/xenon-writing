#!/usr/bin/env python3
"""Public boundary check: fail if anything that must stay private is in this repository.

What it checks (see PUBLIC_BOUNDARY.md):

- Layout: every path must be in the public layout (ALLOWED_* below), so
  private components, design documents and other repositories' files fail
  by default. The app's source and tests hold code file types only
  (DESKTOP_CODE_* below). Also refused anywhere: private/ and datasets/
  directories, .env and other secret files, submodules and Git LFS.
- Denied terms: machine and app names, the owner's personal email address
  and private repository names, in file contents, file and ref names,
  commit and tag messages and identity names. The terms are not in this
  repository: the check reads them from the XENON_BOUNDARY_TERMS
  environment variable (a GitHub Actions secret in CI) or from a local file
  (XENON_BOUNDARY_TERMS_FILE, by default ~/.config/xenon-writing/
  public-boundary-terms), one "category: term" per line, and refuses to run
  without them. Matching ignores case and every non-alphanumeric character,
  and finds a term inside longer words too.
- Secrets: the key and token patterns in tools/check_repository.py.
- Host details: home-directory paths, private network addresses (LAN and
  tailnet ranges) and local host names.
- Design-document pointers: a route card's number or a design document's
  short name. Checked in the tree, staged files and new commit messages,
  not in history: earlier commits used them before this rule, and
  rewriting history is the owner's call.
- Dangling pointers: a path-like reference in a file (say `docs/x.md` or
  `../other/file.py`) that names no file in the tree, which is how pointers
  to private material show up.
- Identities: every commit's author and committer, every tag's tagger, and
  a pending commit must be ALLOWED_NAME <ALLOWED_EMAIL>. Commits must not
  carry signatures or embedded tags, and every ref must lead to a commit.

Modes (combine freely; with none, --tree --history runs):
  --tree          tracked files in the working tree
  --staged        the index and the pending commit's identity (pre-commit)
  --message-file  a commit message file, comment lines included (commit-msg)
  --history       every commit, tag and ref (needs a full, not shallow, clone)
  --push-refs     also check the ref names a pre-push hook reads on stdin

Findings name the place and the rule, never the matched text; a path or ref
whose name contains a denied term is withheld. Exit status: 0 clean,
1 findings, 2 usage or git error, or no term list.
"""
import argparse
import importlib.util
import os
import pathlib
import posixpath
import re
import subprocess
import sys

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
ALLOWED_NAME = 'fakoli'
ALLOWED_EMAIL = 'fakoli@users.noreply.github.com'
TERMS_ENV = 'XENON_BOUNDARY_TERMS'
TERMS_FILE_ENV = 'XENON_BOUNDARY_TERMS_FILE'
DEFAULT_TERMS_FILE = pathlib.Path.home() / '.config' / 'xenon-writing' / 'public-boundary-terms'
TERM_COUNT_ENV = 'XENON_BOUNDARY_TERM_COUNT'
MIN_TERM_CHARS = 6
MAX_TERM_CHARS = 48

# The public layout. Anything else fails, in any letter case. A new top-level
# file, tool or app config file, or a new file type in the app's source or
# tests, lands in two pull requests: this allowlist first, then the file.
ALLOWED_ROOT_FILES = {'.gitignore', 'AGENTS.md', 'CONTRIBUTING.md', 'LICENSE', 'PUBLIC_BOUNDARY.md', 'README.md'}
ALLOWED_FILES = {
    'tools/check_public_boundary.py', 'tools/check_repository.py', 'tools/install_hooks.sh',
    'tests/test_check_public_boundary.py', 'tests/test_repository_guard.py',
} | {'apps/desktop/' + name for name in (
    '.gitignore', 'AGENTS.md', 'CLAUDE.md', 'README.md', 'forge.config.ts', 'index.html', 'package.json',
    'package-lock.json', 'playwright.config.ts', 'playwright.electron.config.ts', 'tsconfig.json',
    'vite.capture.config.ts', 'vite.main.config.ts', 'vite.renderer.config.ts')}
ALLOWED_PREFIXES = ('apps/desktop/src/', 'apps/desktop/tests/', '.github/workflows/', '.githooks/')
# The app's source and tests hold code only.
DESKTOP_CODE_DIRS = ('apps/desktop/src/', 'apps/desktop/tests/')
DESKTOP_CODE_SUFFIXES = ('.ts', '.tsx', '.css', '.html', '.cjs', '.json')
ANY_LEVEL_DENIED = {'private', 'datasets'}
SECRET_FILE_NAMES = {'.npmrc', '.netrc', '.pypirc', '.envrc', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'}

# Generated outputs a file may name although they are not tracked.
GENERATED_PREFIXES = ('.vite/', '.e2e-dist/', 'out/', 'node_modules/', 'test-results/', 'playwright-report/')
GENERATED = GENERATED_PREFIXES + tuple('apps/desktop/' + prefix for prefix in GENERATED_PREFIXES)
# Bases a reference may be relative to, besides the referring file's folder.
POINTER_BASES = ('', 'apps/desktop', 'apps/desktop/src')
POINTER_SUFFIXES = ('.md', '.ts', '.tsx', '.js', '.cjs', '.mjs', '.py', '.css', '.html', '.yml', '.yaml', '.sh', '.json', '.txt')
# Generated, or the tools' own fixtures, which name fake paths on purpose.
POINTER_SKIP = {'apps/desktop/package-lock.json', 'tools/check_public_boundary.py', 'tools/check_repository.py',
                'tests/test_check_public_boundary.py', 'tests/test_repository_guard.py'}
POINTER = re.compile(
    rb'(?<![\w.:/@$-])((?:\.{1,2}/)*(?:[\w.-]+/)+[\w.-]+\.(?:md|py|swift|ts|tsx|js|cjs|mjs|jsonl?|ya?ml|css|html|sh|txt|toml'
    rb'|png|jpe?g|gif|svg|ico|icns|pdf|plist|csv|wav|mp3|m4a|lock|xml|ipynb|docx|xlsx))(?![\w/-])')
# A folder reference: two or more segments ending in a slash, such as `docs/plans/`. (One segment
# would match the end of every regular expression literal, `/like this/`.)
DIR_POINTER = re.compile(rb'(?<![\w.:/@$~-])((?:\.{1,2}/)*(?:[\w.-]+/){2,})(?![\w-])')
# Host details. The tools' own tests use look-alike fixtures on purpose.
HOST_PATTERNS = {
    'home path': re.compile(rb'(?:/Users/|/home/)(?!(?:<|\$|\{|runner/|you/|USER))[A-Za-z0-9._-]+/'),
    'LAN address': re.compile(rb'\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b'),
    # The shared address range (100.64.0.0/10) that tailnets use for their machines.
    'tailnet address': re.compile(rb'\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b'),
    'local host name': re.compile(rb'\b[A-Za-z0-9-]+\.(?:local|lan|ts\.net)\b'),
}
HOST_SKIP = {'tools/check_public_boundary.py', 'tests/test_check_public_boundary.py'}
# Design documents kept out of this repository, named by number or short name (a route card's number). Only
# the current tree, staged files and new messages: history predates the rule. The tools' own
# tests name look-alikes on purpose.
DESIGN_POINTER_PATTERNS = {
    'design document number': re.compile(rb'(?i)\broute\s+card\s+\d'),
    'design document short name': re.compile(
        rb'(?i)\b0\d-(?:interaction|components|trust|delivery|platform|pipeline|route)'),
}
DESIGN_SKIP = {'tools/check_public_boundary.py', 'tests/test_check_public_boundary.py'}
# git commit -v appends the diff below this line; git drops it from the message.
SCISSORS = re.compile(rb'^\S -{24} >8 -{24}$', re.M)

NON_ALNUM = re.compile(rb'[^a-z0-9]')
ALNUM_RUN = re.compile(rb'[A-Za-z0-9]+')
IDENT = re.compile(rb'^(?:author|committer|tagger) (.*) <([^<>]*)> \d+ [+-]\d{4}$')
LFS_POINTER = b'version https://git-lfs.github.com/spec/'
REFUSED_HEADERS = (b'gpgsig', b'gpgsig-sha256', b'mergetag')
SIGNATURE_MARKERS = (b'-----BEGIN PGP SIGNATURE-----', b'-----BEGIN SSH SIGNATURE-----', b'-----BEGIN SIGNED MESSAGE-----')
GIT_ENV = {**os.environ, 'GIT_NO_REPLACE_OBJECTS': '1'}


class TermsMissing(Exception):
    pass


def _secret_patterns():
    spec = importlib.util.spec_from_file_location('check_repository', SCRIPT_DIR / 'check_repository.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.PATTERNS


SECRET_PATTERNS = _secret_patterns()


def normalize(text):
    if isinstance(text, str):
        text = text.encode()
    return NON_ALNUM.sub(b'', text.lower())


def parse_terms(raw):
    """Parse "category: term" lines into {normalized term: category}."""
    terms = {}
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        label, sep, term = line.partition(':')
        if not sep:
            label, term = 'denied term', line
        normalized = normalize(term.strip())
        if len(normalized) < MIN_TERM_CHARS:
            raise TermsMissing(f'a denied term is shorter than {MIN_TERM_CHARS} letters and digits; it would match too much')
        if ':' in term or '\\n' in term or len(normalized) > MAX_TERM_CHARS:
            raise TermsMissing('a term line looks malformed (two entries on one line, or a pasted "\\n"?)')
        terms[normalized] = label.strip() or 'denied term'
    if not terms:
        raise TermsMissing('the term list is empty')
    expected = os.environ.get(TERM_COUNT_ENV, '').strip()
    if expected and (not expected.isdigit() or len(terms) != int(expected)):
        raise TermsMissing(f'expected {expected} denied terms, found {len(terms)}')
    return terms


def load_terms():
    raw = os.environ.get(TERMS_ENV, '')
    if not raw.strip():
        path = pathlib.Path(os.environ.get(TERMS_FILE_ENV) or DEFAULT_TERMS_FILE)
        if not path.is_file():
            raise TermsMissing(f'no term list: set {TERMS_ENV} or create {path} (ask the owner for it)')
        raw = path.read_text(encoding='utf-8')
    return parse_terms(raw)


def _alnum_offset(data, index):
    """Byte offset in data of its index-th letter or digit."""
    seen = 0
    for match in ALNUM_RUN.finditer(data):
        run = match.end() - match.start()
        if seen + run > index:
            return match.start() + index - seen
        seen += run
    return len(data)


def term_findings(data, terms):
    """Sorted (line, category) pairs for every denied term in data.

    A term matches in any letter case, with any separators, and inside a
    longer word, except when a lowercase letter follows it directly: that is
    a different word ("...internally", "...darkness").
    """
    flat = normalize(data)
    found = set()
    for term, label in terms.items():
        at = flat.find(term)
        while at != -1:
            end = _alnum_offset(data, at + len(term) - 1)
            if not (b'a' <= data[end + 1:end + 2] <= b'z'):
                start = _alnum_offset(data, at)
                found.add((data.count(b'\n', 0, start) + 1, label))
            at = flat.find(term, at + 1)
    return sorted(found)


def secret_findings(data):
    found = set()
    for name, pattern in SECRET_PATTERNS.items():
        match = pattern.search(data)
        if match:
            found.add((data.count(b'\n', 0, match.start()) + 1, f'secret pattern: {name}'))
    return sorted(found)


def folders_of(paths):
    folders = set()
    for path in paths:
        parts = path.split('/')[:-1]
        folders.update('/'.join(parts[:i]) for i in range(1, len(parts) + 1))
    return folders


def pointer_findings(name, data, paths, message=False):
    """References to files or folders that are not in the tree.

    For a commit message, `paths` should hold every path in the history, so a
    message may name a file that a later commit removed.
    """
    if not message and (name in POINTER_SKIP or not name.endswith(POINTER_SUFFIXES)):
        return []
    folder = '' if message else posixpath.dirname(name)
    folders = folders_of(paths)
    found = set()
    for pattern, known, what in ((POINTER, paths, 'file'), (DIR_POINTER, folders, 'folder')):
        for match in pattern.finditer(data):
            ref = match.group(1).decode('utf-8', 'replace')
            candidates = [posixpath.normpath(posixpath.join(folder, ref))]
            candidates += [posixpath.normpath(posixpath.join(base, ref)) for base in POINTER_BASES]
            if any(c in known for c in candidates):
                continue
            if any((c + ('/' if what == 'folder' else '')).startswith(GENERATED) for c in candidates):
                continue
            found.add((data.count(b'\n', 0, match.start()) + 1, f'points to a {what} that is not in this repository'))
    return sorted(found)


def host_findings(name, data):
    if name in HOST_SKIP:
        return []
    found = set()
    for label, pattern in HOST_PATTERNS.items():
        match = pattern.search(data)
        if match:
            found.add((data.count(b'\n', 0, match.start()) + 1, label))
    return sorted(found)


def design_findings(name, data):
    if name in DESIGN_SKIP:
        return []
    found = set()
    for label, pattern in DESIGN_POINTER_PATTERNS.items():
        match = pattern.search(data)
        if match:
            found.add((data.count(b'\n', 0, match.start()) + 1, label))
    return sorted(found)


def content_findings(name, data, terms, paths=None, message=False, current=False):
    """`current`: the tree, staged files or a new message, which also get the rules history predates."""
    found = term_findings(data, terms) + secret_findings(data) + host_findings(name, data)
    if current:
        found += design_findings(name, data)
    if data.startswith(LFS_POINTER):
        found.append((1, 'Git LFS pointer'))
    if pathlib.PurePosixPath(name).name == '.gitattributes' and b'filter=lfs' in data:
        found.append((1, 'Git LFS filter'))
    if paths is not None:
        found += pointer_findings(name, data, paths, message)
    return sorted(set(found))


def layout_findings(name, mode=b'100644'):
    parts = pathlib.PurePosixPath(name).parts
    if not parts:
        return ['empty path']
    found = []
    if len(parts) == 1:
        allowed = name in ALLOWED_ROOT_FILES
    else:
        allowed = name in ALLOWED_FILES or name.startswith(ALLOWED_PREFIXES)
    if not allowed:
        found.append('path outside the public layout')
    elif name.startswith(DESKTOP_CODE_DIRS) and not name.endswith(DESKTOP_CODE_SUFFIXES):
        found.append('file type outside the public layout')
    lowered = [part.lower() for part in parts]
    if any(part in ANY_LEVEL_DENIED for part in lowered):
        found.append('private data path')
    base = lowered[-1]
    if base.startswith('.env') or base.endswith('.env') or base in SECRET_FILE_NAMES:
        found.append('secret file')
    if mode == b'160000':
        found.append('submodule')
    return found


class Report:
    def __init__(self, terms):
        self.terms = terms
        self.findings = set()
        self.paths = 0
        self.blobs = 0
        self.commits = 0

    def add(self, finding):
        self.findings.add(finding)

    def display(self, name, oid=''):
        """A path or ref name as printed: withheld when it contains a denied term."""
        hits = term_findings(name.encode('utf-8', 'surrogateescape'), self.terms)
        if not hits:
            return name
        return f'<name withheld ({hits[0][1]}){" " + oid[:12] if oid else ""}>'

    def path(self, prefix, name, mode, oid):
        self.paths += 1
        shown = self.display(name, oid)
        for reason in layout_findings(name, mode):
            self.add(f'{prefix}{shown}: {reason}')
        if shown != name:
            self.add(f'{prefix}{shown}: name contains a denied term')
        return shown

    def content(self, place, name, data, paths=None, message=False, current=False):
        for line, reason in content_findings(name, data, self.terms, paths, message, current):
            self.add(f'{place}:{line}: {reason}')

    def identity(self, where, role, line):
        match = IDENT.match(line)
        if not match:
            self.add(f'{where}: {role} line is malformed')
            return
        name, email = match.group(1).decode('utf-8', 'replace'), match.group(2).decode('utf-8', 'replace')
        if name != ALLOWED_NAME:
            self.add(f'{where}: {role} name is not {ALLOWED_NAME}')
        if email.strip().lower() != ALLOWED_EMAIL:
            self.add(f'{where}: {role} email is not {ALLOWED_EMAIL}')


def git(root, *args, data=None):
    return subprocess.run(['git', *args], cwd=root, input=data, capture_output=True, check=True, env=GIT_ENV).stdout


def read_objects(root, oids):
    """Yield (oid, type, content) through one `git cat-file --batch` process."""
    if not oids:
        return
    out = git(root, 'cat-file', '--batch', data=b''.join(oid.encode() + b'\n' for oid in oids))
    pos = 0
    for _ in oids:
        end = out.index(b'\n', pos)
        header = out[pos:end].split()
        if header[-1] == b'missing':
            raise RuntimeError(f'git object missing: {header[0].decode()}')
        size = int(header[2])
        yield header[0].decode(), header[1].decode(), out[end + 1:end + 1 + size]
        pos = end + 1 + size + 1


def index_entries(root):
    entries = []
    for row in git(root, 'ls-files', '-s', '-z').split(b'\0'):
        if row:
            info, name = row.split(b'\t', 1)
            mode, oid, _stage = info.split()
            entries.append((mode, oid.decode(), name.decode('utf-8', 'surrogateescape')))
    return entries


def scan_tree(root, report):
    entries = index_entries(root)
    paths = {name for _, _, name in entries}
    for mode, oid, name in entries:
        shown = report.path('', name, mode, oid)
        path = pathlib.Path(root) / name
        if mode != b'160000' and path.is_file() and not path.is_symlink():
            report.blobs += 1
            report.content(shown, name, path.read_bytes(), paths, current=True)


def scan_staged(root, report):
    entries = index_entries(root)
    paths = {name for _, _, name in entries}
    blobs = {}
    for mode, oid, name in entries:
        shown = report.path('staged ', name, mode, oid)
        if mode != b'160000':
            blobs.setdefault(oid, (shown, name))
    for oid, _type, data in read_objects(root, list(blobs)):
        report.blobs += 1
        shown, name = blobs[oid]
        report.content(f'staged {shown}', name, data, paths, current=True)
    for var, role in (('GIT_AUTHOR_IDENT', 'author'), ('GIT_COMMITTER_IDENT', 'committer')):
        report.identity('pending commit', role, f'{role} '.encode() + git(root, 'var', var).strip())


def history_paths(root):
    paths = set()
    for oid in git(root, 'rev-list', '--exclude=refs/stash', '--all').decode().split():
        for row in git(root, 'ls-tree', '-r', '-z', '--name-only', oid).split(b'\0'):
            if row:
                paths.add(row.decode('utf-8', 'surrogateescape'))
    return paths


def scan_message_file(root, report, path):
    data = pathlib.Path(path).read_bytes()
    cut = SCISSORS.search(data)
    if cut:
        data = data[:cut.start()]
    paths = history_paths(root) | {name for _, _, name in index_entries(root)}
    report.content('commit message', '', data, paths, message=True, current=True)


def check_object_headers(report, where, headers):
    for line in headers:
        key = line.split(b' ', 1)[0]
        if key in REFUSED_HEADERS:
            report.add(f'{where}: carries a {key.decode()} header (commits here are unsigned and plain)')
        elif key in (b'author', b'committer', b'tagger'):
            report.identity(where, key.decode(), line)
    for line_no, reason in term_findings(b'\n'.join(headers), report.terms):
        report.add(f'{where} header:{line_no}: {reason}')


def split_object(raw):
    head, _, message = raw.partition(b'\n\n')
    return head.split(b'\n'), message


def scan_history(root, report):
    if git(root, 'rev-parse', '--is-shallow-repository').strip() == b'true':
        raise RuntimeError('shallow clone: the history check needs the full history (fetch-depth: 0)')
    commits = git(root, 'rev-list', '--exclude=refs/stash', '--all').decode().split()
    blobs = {}
    messages = []
    every_path = set()
    for oid, _type, raw in read_objects(root, commits):
        report.commits += 1
        where = f'commit {oid[:12]}'
        headers, message = split_object(raw)
        check_object_headers(report, where, headers)
        if any(marker in message for marker in SIGNATURE_MARKERS):
            report.add(f'{where}: message carries a signature')
        messages.append((where, message))
        rows = [row for row in git(root, 'ls-tree', '-r', '-z', oid).split(b'\0') if row]
        entries = []
        for row in rows:
            info, name = row.split(b'\t', 1)
            mode, _kind, blob = info.split()
            entries.append((mode, blob.decode(), name.decode('utf-8', 'surrogateescape')))
        paths = {name for _, _, name in entries}
        every_path |= paths
        for mode, blob, name in entries:
            shown = report.path(f'{where} ', name, mode, blob)
            if mode != b'160000':
                blobs.setdefault(blob, (where, shown, name, paths))
    for oid, _type, data in read_objects(root, list(blobs)):
        report.blobs += 1
        where, shown, name, paths = blobs[oid]
        report.content(f'{where} {shown}', name, data, paths)
    for where, message in messages:
        report.content(f'{where} message', '', message, every_path, message=True)
    scan_refs(root, report)


def scan_refs(root, report):
    rows = git(root, 'for-each-ref', '--format=%(objectname) %(objecttype) %(refname)').decode('utf-8', 'surrogateescape')
    for row in rows.splitlines():
        oid, kind, ref = row.split(' ', 2)
        if ref == 'refs/stash':
            continue
        shown = report.display(ref, oid)
        if shown != ref:
            report.add(f'ref {shown}: name contains a denied term')
        seen = 0
        while kind == 'tag' and seen < 16:
            seen += 1
            (_, _, raw), = read_objects(root, [oid])
            headers, message = split_object(raw)
            where = f'tag {oid[:12]} ({shown})'
            check_object_headers(report, where, headers)
            if any(marker in message for marker in SIGNATURE_MARKERS):
                report.add(f'{where}: message carries a signature')
            report.content(f'{where} message', '', message)
            fields = dict(line.split(b' ', 1) for line in headers if b' ' in line)
            oid, kind = fields.get(b'object', b'').decode(), fields.get(b'type', b'').decode()
        if kind != 'commit':
            report.add(f'ref {shown}: leads to a {kind or "missing object"}, not a commit')


def scan_push_refs(report, stream):
    for line in stream.read().splitlines():
        for ref in line.split()[0::2]:
            shown = report.display(ref)
            if shown != ref:
                report.add(f'push ref {shown}: name contains a denied term')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n', 1)[0])
    parser.add_argument('--tree', action='store_true')
    parser.add_argument('--staged', action='store_true')
    parser.add_argument('--message-file')
    parser.add_argument('--history', action='store_true')
    parser.add_argument('--push-refs', action='store_true')
    parser.add_argument('--root', default=str(SCRIPT_DIR.parent), help='repository to check (default: this one)')
    args = parser.parse_args(argv)
    if not (args.tree or args.staged or args.message_file or args.history or args.push_refs):
        args.tree = args.history = True
    try:
        report = Report(load_terms())
    except TermsMissing as error:
        print(f'Public boundary: cannot run: {error}. See PUBLIC_BOUNDARY.md.', file=sys.stderr)
        return 2
    try:
        if args.push_refs:
            scan_push_refs(report, sys.stdin)
        if args.tree:
            scan_tree(args.root, report)
        if args.staged:
            scan_staged(args.root, report)
        if args.message_file:
            scan_message_file(args.root, report, args.message_file)
        if args.history:
            scan_history(args.root, report)
    except subprocess.CalledProcessError as error:
        print(f'Public boundary: git failed: {" ".join(map(str, error.cmd))}', file=sys.stderr)
        return 2
    except RuntimeError as error:
        print(f'Public boundary: {error}', file=sys.stderr)
        return 2
    unique = sorted(report.findings)
    for finding in unique:
        print(finding)
    print(f'Public boundary: checked {report.paths} paths, {report.blobs} blobs, {report.commits} commits, '
          f'{len(report.terms)} denied terms; {len(unique)} findings.')
    if unique:
        print('Fix the findings above; see PUBLIC_BOUNDARY.md. Do not bypass or weaken this check.')
    return 1 if unique else 0


if __name__ == '__main__':
    raise SystemExit(main())
