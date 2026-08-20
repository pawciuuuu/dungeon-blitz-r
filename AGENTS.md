# Agent Instructions

## Committing

- Never commit or push automatically. Stop and ask the user for explicit approval before committing, pushing, merging, or opening a pull request.
- Leave changes uncommitted in the worktree for the user to review unless they explicitly asked you to commit.

## Versioning / package.json

- Never modify `package.json`, `package-lock.json`, or any version metadata on your own initiative.
- Version bumps (`patch` / `minor` / `major`) and dependency changes are decided and applied by the user, or only after an explicit request.
- If completed work would normally imply a version bump or dependency change, mention it in your final summary and let the user apply it.

## Binary Asset Locking (SWF)

SWF files are binary — Git cannot merge them line by line, so two people editing the same SWF in parallel produce an unresolvable conflict (Git can only keep one side). This is not fixable in an editor. To prevent this at the source, SWF (and other binary assets) are tracked with Git LFS and locked before editing.

- SWF and other binary assets are declared lockable in `.gitattributes`:
  ```
  *.swf filter=lfs diff=lfs merge=lfs -text lockable
  ```
- Never edit an SWF (or other lockable binary) without holding its lock first. Locking makes parallel edits impossible, which is the only reliable way to avoid binary conflicts.
  - Lock before editing: `git lfs lock <path/to/asset.swf>`
  - Check existing locks first: `git lfs locks` — if someone else holds the lock, do not edit; coordinate with them instead.
- Unlock only after the change is committed and pushed:
  - `git lfs unlock <path/to/asset.swf>`
- Never force-unlock (`git lfs unlock --force`) someone else's lock unless the user explicitly asks.
- If a lockable binary shows a conflict at merge time, stop and ask the user — do not resolve it by blindly picking a side.

## Worktree Workflow

Do all work in a git worktree on a new branch — never work directly on the shared checkout. Before editing any SWF or other lockable binary inside a worktree, acquire its LFS lock first (see Binary Asset Locking).

1. Base the new branch on the current release branch, synced with origin. Identify the current release branch first (e.g. `git branch -r --list 'origin/release/*'` and pick the active one), then:
   - `git fetch origin && git checkout <release-branch> && git pull --ff-only`
2. Create the worktree on the new branch:
   - `git worktree add -b <branch> ../dungeon-blitz-r-<suffix> <release-branch>`
3. Copy the gitignored local runtime data from the shared checkout into the worktree, so it
   starts with the same accounts, saves, and environment a fresh `git worktree add` does not
   carry (these paths never travel with a branch):
   - `cp src/server/Accounts.json ../dungeon-blitz-r-<suffix>/src/server/Accounts.json`
   - `mkdir -p ../dungeon-blitz-r-<suffix>/src/server/data/saves && cp src/server/data/saves/*.json ../dungeon-blitz-r-<suffix>/src/server/data/saves/`
   - `cp src/server/.env ../dungeon-blitz-r-<suffix>/src/server/.env`
     Guard each `cp` with `[ -f ... ] &&` so a checkout that never had the file does not fail.
4. Implement the change inside the worktree and commit it there. If the change touches a lockable binary, hold its LFS lock for the duration of the edit.
5. Push the branch to the remote so the work is available:
   - `git push -u origin <branch>`
6. Once all worktrees for that branch are done, merge them into one and finish:
   - In a worktree with the release branch checked out, squash-merge the worktree branch(es) into a single commit:
     - `git merge --squash <branch> && git commit`
   - Push the release branch: `git push origin <release-branch>`
   - Release any LFS locks held for that work: `git lfs unlock <path>` (verify with `git lfs locks`).
   - Clean up: remove the worktree(s) (`git worktree remove <path> --force` if needed) and delete the temporary branch (`git branch -d <branch>`).

## Branch Cleanup

- Keep the local checkout tidy: once a branch's work has been merged on the origin and its upstream remote branch no longer exists, delete the local branch.
- Detect merged branches by pruning stale remote-tracking refs:
  - `git fetch origin --prune`
  - `git branch -vv` shows the upstream as `[gone]` once the remote branch is deleted.
- Delete with `git branch -d <branch>`. If the merge landed as a squash (so `-d` refuses because the tip is not an ancestor), verify the upstream is gone and use `git branch -D <branch>`.
- Never delete a branch whose remote counterpart still exists on the origin unless the user explicitly asks.
