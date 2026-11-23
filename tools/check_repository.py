#!/usr/bin/env python3
"""Heuristic source-only guard. Not a complete secret scanner or privacy audit."""
import argparse
import os
import pathlib
import re
import subprocess

DENIED_DIRS={'private','datasets','checkpoints','outputs','credentials','secrets','.build','node_modules','__pycache__'}
DENIED_SUFFIXES={'.wav','.aiff','.mp3','.m4a','.safetensors','.ckpt','.pt','.pth','.gguf','.db','.sqlite','.sqlite3','.pem','.p12','.key','.jsonl'}
PATTERNS={
    'private-key': re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'github-token': re.compile(rb'gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}'),
    'aws-access-key': re.compile(rb'AKIA[A-Z0-9]{16}'),
    'provider-key': re.compile(rb'sk-(?:proj-|ant-)[A-Za-z0-9_-]{24,}'),
    'openai-key': re.compile(rb'(?<![A-Za-z0-9_-])sk-(?:svcacct-|admin-)?[A-Za-z0-9_-]{32,}'),
    'google-api-key': re.compile(rb'AIza[0-9A-Za-z_-]{35}'),
    'perplexity-key': re.compile(rb'pplx-[A-Za-z0-9]{40,}'),
    'npm-token': re.compile(rb'npm_[A-Za-z0-9]{36}'),
    'huggingface-token': re.compile(rb'hf_[A-Za-z0-9]{30,}'),
    'slack-token': re.compile(rb'xox[abposr]-[A-Za-z0-9-]{10,}'),
    'assigned-secret': re.compile(rb'(?i:api[_-]?key|secret|token|password)["\']?\s*[:=]\s*["\'](?=[^"\'\s]*[0-9])(?=[^"\'\s]*[A-Z])[A-Za-z0-9_/+=]{24,}["\']'),
}
def path_issues(name):
    p=pathlib.PurePosixPath(name)
    return ['private/generated path'] if (any(x in DENIED_DIRS for x in p.parts) or p.suffix.lower() in DENIED_SUFFIXES or p.name=='.env' or (p.name.startswith('.env.') and not p.name.endswith('.example'))) else []
def content_issues(data):
    return (['binary content'] if b'\0' in data else [])+[name for name,pattern in PATTERNS.items() if pattern.search(data)]
def git(*args):
    return subprocess.check_output(['git',*args],env={**os.environ,'GIT_NO_REPLACE_OBJECTS':'1'})
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--history',action='store_true');args=parser.parse_args()
    findings=[];blobs={};paths=set()
    if args.history:
        for commit in git('rev-list','--exclude=refs/stash','--all').decode().splitlines():
            for row in git('ls-tree','-r','-z',commit).split(b'\0'):
                if not row:continue
                info,name=row.split(b'\t',1);mode,kind,oid=info.split();name=name.decode()
                paths.add(name)
                if mode==b'120000':findings.append((name,'symlink requires manual review'))
                if kind==b'blob':blobs.setdefault(oid.decode(),name)
    else:
        for raw in git('ls-files','-z').split(b'\0'):
            if not raw:continue
            name=raw.decode();paths.add(name)
            p=pathlib.Path(name)
            if p.is_symlink():findings.append((name,'symlink requires manual review'))
            elif p.is_file():
                for reason in content_issues(p.read_bytes()):findings.append((name,reason))
    for name in paths:
        for reason in path_issues(name):findings.append((name,reason))
    for oid,name in blobs.items():
        for reason in content_issues(git('cat-file','blob',oid)):findings.append((name,reason))
    for name,reason in sorted(set(findings)):print(f'{name}: {reason}')
    print(f'Checked {len(paths)} paths, {len(blobs)} historical blobs; {len(set(findings))} findings. Heuristics only; human review still required.')
    return bool(findings)
if __name__=='__main__':raise SystemExit(main())
