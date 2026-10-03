#!/usr/bin/env sh
#
# Make `git push` work in a Paperclip execution workspace that runs an old git.
#
# WHY THIS EXISTS (DUB-7)
#
# The runner image ships git 2.25.1. Paperclip's managed GitHub launcher gives
# credentials to git through the environment variables GIT_CONFIG_COUNT,
# GIT_CONFIG_KEY_n and GIT_CONFIG_VALUE_n. Git reads those only from version
# 2.31. Git 2.25.1 ignores them and gives no message, so the managed credential
# helper never loads and every push stops with:
#
#   fatal: could not read Username for 'https://github.com': terminal prompts disabled
#
# `gh` is not affected, because it reads GH_TOKEN instead of git config. So
# `gh auth status` shows a healthy login while `git push` and `git ls-remote`
# both fail. This makes the fault easy to diagnose incorrectly.
#
# WHAT THIS SCRIPT DOES
#
# It writes a repository-local credential helper that reads the variable
# PAPERCLIP_GIT_TOKEN, which the launcher does put into git's environment.
# Repository config in .git/config IS honoured by git 2.25.
#
# No token is written to disk. Only the NAME of the variable is stored. The
# variable itself exists only inside a launcher-managed git call.
#
# HOW TO USE IT
#
# Run it one time in each fresh workspace:
#
#   sh tools/paperclip-git-credentials.sh
#
# Then push through the launcher, so that PAPERCLIP_GIT_TOKEN is present:
#
#   "$PAPERCLIP_GITHUB_LAUNCHER_DIR/git" push -u origin HEAD
#
# The script does nothing if git is 2.31 or newer. Delete the script when the
# runner image carries git 2.31 or newer.

set -eu

if ! git rev-parse --git-dir >/dev/null 2>&1; then
	echo "paperclip-git-credentials: not inside a git repository." >&2
	exit 1
fi

version=$(git --version | awk '{ print $3 }')
major=${version%%.*}
rest=${version#*.}
minor=${rest%%.*}

case "$major$minor" in
*[!0-9]*)
	echo "paperclip-git-credentials: cannot read git version '$version'." >&2
	exit 1
	;;
esac

if [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -ge 31 ]; }; then
	echo "git $version reads GIT_CONFIG_COUNT. No workaround needed."
	exit 0
fi

# Single quotes are deliberate: git must store this string literally. The
# expansion of $1 and $PAPERCLIP_GIT_TOKEN happens later, in the shell that
# git starts when it asks for credentials.
git config --local --replace-all 'credential.https://github.com.helper' \
	'!f() { test "$1" = get && printf "username=x-access-token\npassword=%s\n" "$PAPERCLIP_GIT_TOKEN"; }; f'

echo "git $version ignores GIT_CONFIG_COUNT (needs 2.31)."
echo "Installed a repository-local credential helper in .git/config."
echo
echo "Push through the launcher so the token is in git's environment:"
echo '  "$PAPERCLIP_GITHUB_LAUNCHER_DIR/git" push -u origin HEAD'
