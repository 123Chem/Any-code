# Windows repair builds

This fork retains the original Any Code application identity and ships manual
Windows x64 updates. The base is AnyCode 5.29.1 at
`3a815730c2f37883764fabf9e2b593aecb3026de`; the repair version is 5.29.2.
The upstream AGPL-3.0 license remains in effect.

## Reproducible build

Push the reviewed source to this fork's `main`, or run the
**AnyCode Windows Repair** workflow. It uses Node 22, Rust 1.88.0,
`package-lock.json`, and `src-tauri/Cargo.lock`.

The workflow validates TypeScript, lint, the existing size gate, and frontend
tests. It builds the frontend, runs native tests, and creates a production NSIS
installer. It uploads the installer, executable ZIP, and a build manifest with
the exact source commit and SHA-256 hashes. Artifacts expire after seven days;
successful builds also have a draft release for review.

Use release files from this fork after checking the matching build manifest.
The original upstream updater is disabled so it cannot replace these patches.
No updater private key or fabricated updater signature is required.

## Runtime and installation

The application identifier is `claude.workbench.app`, the product name is
`Any Code`, and installation uses the original `perMachine` NSIS contract.
Finish active tasks and exit the previous application before replacing it.
Keep an application-consistent backup of existing data when installing or
rolling back. An active SQLite database is not backed up by copying its main
file alone.

Running the application does not require Rust targets or frontend dependencies.
Do not download GitHub's build cache to the client machine. Retain the current
installer, the selected rollback version, source commit, and build manifest.

Claude effort uses the real `low`, `medium`, `high`, `xhigh`, and `max` levels.
There is no additional native `ultra` level. An explicit session override is
applied to that work process; following Claude settings preserves its defaults.
Native auto-compaction is controlled per session and applies on the next turn.

Unbound tabs keep separate drafts. The original shared legacy draft is retained
for explicit recovery into one selected empty input, without auto-distributing
it across projects.

Keep original project directories, session UUIDs, and native history files.
The application resolves logical project ownership from trusted session cwd
metadata. Changing the display identity does not rewrite past context or
automatically transfer memories from another project.

## Maintaining patches

Review upstream changes before updating this fork. Remove a patch only after
the upstream behavior passes the same regression checks. Update dependencies
and lock files deliberately, then validate and build again.

If building locally, use the same pinned toolchain and one reusable target.
`npm ci`, `npm run validate`, `npm run build`, and the Windows CI workflow show
the required commands. Local compilation needs temporary disk space; using
the GitHub workflow keeps that temporary space off the client machine.
