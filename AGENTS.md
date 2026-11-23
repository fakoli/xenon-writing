# Agent guide

Read README.md, [PUBLIC_BOUNDARY.md](PUBLIC_BOUNDARY.md) and apps/desktop/AGENTS.md before changing anything.

- **This repository is public-facing.** PUBLIC_BOUNDARY.md says what may live here. Never add personal writing or audio, pipeline or training code, design documents, machine names, account identifiers, personal email addresses or links to private repositories.
- **Every commit passes `tools/check_public_boundary.py`.** Run `tools/install_hooks.sh` once per clone; the hooks need the private denied-term list described in CONTRIBUTING.md. Never bypass the hooks with `--no-verify`. If the check fails, remove the material; never weaken the check to make it pass. Never print, log or commit the denied terms.
- **No pointers to private material:** no design-document paths, short names or numbers, no decision or finding numbers from them, and no pull request numbers from other repositories. Restate the fact in plain words instead.
- **Identity:** commit as `fakoli <fakoli@users.noreply.github.com>`, unsigned. The check refuses any other author or committer anywhere in history, so set it before the first commit.
- Never commit credentials, datasets, model weights, recordings or generated outputs. Fixtures are fictional text and generated audio only.
- Default checks are synthetic, CPU-only and zero-secret. Dependencies are pinned exactly; adding or upgrading one is a reviewed change.
- Keep the strict CSP in `apps/desktop/index.html`, render model output as text only, and never grant the app window media access.
- Work in a branch, one pull request per change. Merge only after the checks pass and an independent review, by fast-forward (see CONTRIBUTING.md).
