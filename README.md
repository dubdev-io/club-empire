# club-empire
Browser-based idle nightclub tycoon. TypeScript + Vite + PixiJS + React.

## If `git push` fails in a fresh Paperclip workspace

The runner image ships git 2.25.1, which is too old to read the credentials
that the managed GitHub launcher passes through `GIT_CONFIG_COUNT` (git 2.31
and newer only). Pushes then stop with `could not read Username for
'https://github.com'`, while `gh auth status` still reports a healthy login.

Run this one time per workspace, then push through the launcher:

```bash
sh tools/paperclip-git-credentials.sh
"$PAPERCLIP_GITHUB_LAUNCHER_DIR/git" push -u origin HEAD
```

The script explains the cause in full and does nothing on git 2.31 or newer.
See DUB-7; delete both when the runner image is updated.
