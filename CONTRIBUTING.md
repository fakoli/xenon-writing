# Contributing

## Set up a clone

```sh
git config user.name fakoli
git config user.email fakoli@users.noreply.github.com
git config commit.gpgsign false
tools/install_hooks.sh
```

The hooks need the denied-term list, a private file the owner keeps outside the repository. It lives at `~/.config/xenon-writing/public-boundary-terms`, or the path in `XENON_BOUNDARY_TERMS_FILE`. It has one `category: term` per line. Without it every hook refuses to run. Never commit it, and never put its terms in an issue, pull request or log.

Commit dates carry your time zone. To leave it out, commit with `TZ=UTC`.

## Make a change

1. Branch from `main` and keep each pull request to one change.
2. Run the checks in [README.md](README.md). Tests use fictional text and generated audio only; no live service, microphone or network.
3. Open a pull request. The `public-boundary` job and the desktop jobs must pass; `main` requires `public-boundary`.
4. Get an independent review of the change, including a check against [PUBLIC_BOUNDARY.md](PUBLIC_BOUNDARY.md). Pull request titles and descriptions are not scanned, so keep private material out of them too.

A new top-level file, tool or test file, or a new file type under `apps/desktop/src/` or `apps/desktop/tests/`, must first be added to the layout allowlist in `tools/check_public_boundary.py`. Land that in its own pull request, then add the file in the next one; `main`'s scanner checks every pull request.

## Merge

GitHub's merge, squash and rebase buttons create commits whose committer is GitHub's own address, and the boundary check refuses those. Merge by fast-forwarding `main` to the reviewed branch once its checks have passed:

```sh
git fetch origin
git switch main
git merge --ff-only origin/<branch>
git push origin main
```

If the branch is behind `main`, merge `main` into the branch, let the checks run again, then fast-forward.

If private material is ever found in pushed history, stop and tell the owner; rewriting history is the owner's call. During such a rewrite the `pre-push` hook keeps refusing while stale remote-tracking refs for `origin` still point at the old commits; delete them with `git update-ref -d` once the rewrite is pushed.
