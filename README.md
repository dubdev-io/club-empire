# club-empire
Browser-based idle nightclub tycoon. TypeScript + Vite + PixiJS + React.

## If `git push` fails in a fresh Paperclip workspace

The runner is Ubuntu 20.04 and its git is 2.25.1. That git is too old to read
the environment variables the managed GitHub launcher uses, and it reports no
error when it ignores them. Two things break silently:

- **Credentials never reach git.** They arrive through `GIT_CONFIG_COUNT`,
  which git reads only from 2.31. Writes stop with `could not read Username
  for 'https://github.com'`, while `gh auth status` still reports a healthy
  login. Reads of a public repository keep working, which hides the cause.
- **Config isolation does not hold.** The launcher sets `GIT_CONFIG_GLOBAL`
  and `GIT_CONFIG_SYSTEM` to `/dev/null`, which git reads only from 2.32.

Put a git of 2.32 or newer first on PATH, and both faults go away:

```bash
eval "$(sh tools/paperclip-git.sh --activate)"
```

It needs no root. On first use it unpacks the official git-core PPA build for
Ubuntu 20.04 into a cache directory, after checking it against a pinned
SHA-256 digest; later workspaces reuse that cache and start in under a second.
It writes no credentials and no git config, and does nothing if your git is
already recent enough.

See DUB-7. Delete this section and the script once the host git is upgraded.
