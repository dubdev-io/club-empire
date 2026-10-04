#!/usr/bin/env sh
#
# Put a modern git on PATH in a Paperclip execution workspace.
#
# WHY THIS EXISTS (DUB-7)
#
# The runner is Ubuntu 20.04 and its git is 2.25.1. Paperclip's managed GitHub
# launcher configures git through environment variables that git 2.25.1 does
# not read. Git ignores them and prints no message, so two things break at the
# same time and neither says so:
#
#   1. Credentials never reach git. The launcher passes them with
#      GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n, which git
#      reads only from version 2.31. Every write to the remote stops with:
#
#        fatal: could not read Username for 'https://github.com': terminal prompts disabled
#
#      Reads of a public repository still work, which hides the fault.
#      `gh` is not affected, because it reads GH_TOKEN instead of git config,
#      so `gh auth status` shows a healthy login while `git push` fails.
#
#   2. Config isolation does not hold. The launcher sets
#      GIT_CONFIG_GLOBAL=/dev/null and GIT_CONFIG_SYSTEM=/dev/null to keep
#      managed calls away from host configuration. Git reads those only from
#      version 2.32, so on 2.25.1 the control is a silent no-op.
#
# Both faults have one cause: the git on the host is too old. The target is
# therefore git 2.32 or newer, which is what this script gives you.
#
# WHAT THIS SCRIPT DOES
#
# It unpacks the official git-core PPA build of git for Ubuntu 20.04 into a
# directory you own, and prints the PATH entry that makes it the git that runs.
# It needs no root. It changes nothing outside its own cache directory, and it
# writes no credentials and no git configuration anywhere.
#
# The download is checked against a pinned SHA-256 digest before it is used.
#
# HOW TO USE IT
#
#   eval "$(sh tools/paperclip-git.sh --activate)"
#
# That one line installs git on first use, then puts it first on PATH for the
# current shell. Check it with `git --version`. After that, use git and the
# launcher as normal:
#
#   "$PAPERCLIP_GITHUB_LAUNCHER_DIR/git" push -u origin HEAD
#
# Other modes:
#
#   sh tools/paperclip-git.sh            install if needed, report what to do
#   sh tools/paperclip-git.sh --path     print only the directory to prepend
#   sh tools/paperclip-git.sh --check    report the version verdict, install nothing
#
# The script does nothing if the git already on PATH is 2.32 or newer. When the
# host git is upgraded, this file and the README section that points at it can
# both be deleted.

set -eu

GIT_VERSION_WANTED=2.32

# The git-core PPA build for Ubuntu 20.04 (focal). The digest is the SHA256
# field for this file in the PPA's signed package index.
PKG_VERSION=2.50.1
PKG_FILE=git_2.50.1-0ppa1~ubuntu20.04.1_amd64.deb
PKG_URL=https://ppa.launchpadcontent.net/git-core/ppa/ubuntu/pool/main/g/git/$PKG_FILE
PKG_SHA256=ee99ab0656b9efd02b2fe3f4adef0ae3e31a8ce6da526d495cb475b70e5e157e

mode=${1:---install}

case "$mode" in
--install | --activate | --path | --check) ;;
-h | --help)
	sed -n '2,/^set -eu$/p' "$0" | sed 's/^# \{0,1\}//; $d'
	exit 0
	;;
*)
	echo "paperclip-git: unknown option '$mode'." >&2
	echo "paperclip-git: use --install, --activate, --path or --check." >&2
	exit 2
	;;
esac

say() {
	# Keep stdout clean in the modes whose output is consumed by the shell.
	case "$mode" in
	--activate | --path) echo "$@" >&2 ;;
	*) echo "$@" ;;
	esac
}

# Report whether $1 is at least $GIT_VERSION_WANTED. Only the first two
# components are compared; git has never needed a third to settle this.
version_is_recent_enough() {
	_v=$1
	_major=${_v%%.*}
	_rest=${_v#*.}
	_minor=${_rest%%.*}

	case "$_major:$_minor" in
	*[!0-9:]* | :* | *:) return 2 ;;
	esac

	_want_major=${GIT_VERSION_WANTED%%.*}
	_want_minor=${GIT_VERSION_WANTED#*.}

	if [ "$_major" -gt "$_want_major" ]; then return 0; fi
	if [ "$_major" -lt "$_want_major" ]; then return 1; fi
	[ "$_minor" -ge "$_want_minor" ]
}

current_version=$(git --version 2>/dev/null | awk '{ print $3 }' || true)

if [ -z "$current_version" ]; then
	echo "paperclip-git: no git found on PATH." >&2
	exit 1
fi

version_is_recent_enough "$current_version" && verdict=0 || verdict=$?

if [ "$verdict" -eq 2 ]; then
	echo "paperclip-git: cannot read git version '$current_version'." >&2
	exit 1
fi

if [ "$verdict" -eq 0 ]; then
	say "git $current_version reads GIT_CONFIG_COUNT and GIT_CONFIG_GLOBAL. Nothing to do."
	exit 0
fi

if [ "$mode" = "--check" ]; then
	echo "git $current_version is too old: it silently ignores the launcher's"
	echo "credential and isolation settings. Need $GIT_VERSION_WANTED or newer."
	echo "Run: eval \"\$(sh tools/paperclip-git.sh --activate)\""
	exit 1
fi

# Pick a cache root that survives this workspace if one is available, so the
# download happens once per runner rather than once per workspace.
if [ -n "${PAPERCLIP_GIT_TOOLCHAIN_ROOT:-}" ]; then
	root=$PAPERCLIP_GIT_TOOLCHAIN_ROOT
elif [ -w /var/lib/paperclip/.paperclip ]; then
	root=/var/lib/paperclip/.paperclip/tools/git
else
	root=${HOME:?HOME is not set}/.cache/paperclip-git
fi

install_dir=$root/$PKG_VERSION
bin_dir=$install_dir/bin

if [ ! -x "$bin_dir/git" ]; then
	for tool in curl sha256sum dpkg-deb; do
		command -v "$tool" >/dev/null 2>&1 || {
			echo "paperclip-git: '$tool' is required but not installed." >&2
			exit 1
		}
	done

	say "git $current_version is too old. Installing git $PKG_VERSION into $install_dir"

	mkdir -p "$root"
	# Build in a sibling directory and move it into place, so a concurrent or
	# interrupted run never leaves a half-unpacked install behind.
	work=$(mktemp -d "$root/.staging-$PKG_VERSION.XXXXXX")
	trap 'rm -rf "$work"' EXIT INT TERM

	say "paperclip-git: downloading $PKG_FILE"
	curl -fsS --retry 3 --retry-delay 2 --max-time 300 -o "$work/$PKG_FILE" "$PKG_URL"

	say "paperclip-git: verifying digest"
	printf '%s  %s\n' "$PKG_SHA256" "$work/$PKG_FILE" | sha256sum -c --quiet - || {
		echo "paperclip-git: digest mismatch for $PKG_FILE; refusing to install." >&2
		exit 1
	}

	mkdir -p "$work/stage/prefix" "$work/stage/bin"
	dpkg-deb -x "$work/$PKG_FILE" "$work/stage/prefix"

	# This build is compiled for /usr, so its own idea of the exec path points
	# at the host's old git helpers. Pin both paths into the prefix instead.
	cat >"$work/stage/bin/git" <<'WRAPPER'
#!/bin/sh
# Run the unpacked git with its own helpers, not the host's older ones.
self=$0
while [ -L "$self" ]; do
	link=$(readlink "$self")
	case "$link" in
	/*) self=$link ;;
	*) self=$(dirname "$self")/$link ;;
	esac
done
base=$(cd "$(dirname "$self")/.." && pwd)
GIT_EXEC_PATH=$base/prefix/usr/lib/git-core
GIT_TEMPLATE_DIR=$base/prefix/usr/share/git-core/templates
export GIT_EXEC_PATH GIT_TEMPLATE_DIR
exec "$base/prefix/usr/bin/git" "$@"
WRAPPER
	chmod 0755 "$work/stage/bin/git"

	"$work/stage/bin/git" --version >/dev/null || {
		echo "paperclip-git: the unpacked git does not run on this host." >&2
		exit 1
	}

	if [ ! -x "$bin_dir/git" ]; then
		mv "$work/stage" "$install_dir" 2>/dev/null || {
			# Another run won the race; its install is equally good.
			[ -x "$bin_dir/git" ] || {
				echo "paperclip-git: could not install into $install_dir." >&2
				exit 1
			}
		}
	fi

	rm -rf "$work"
	trap - EXIT INT TERM
fi

installed_version=$("$bin_dir/git" --version | awk '{ print $3 }')

case "$mode" in
--path)
	echo "$bin_dir"
	;;
--activate)
	say "paperclip-git: git $installed_version is now first on PATH."
	echo "export PATH=\"$bin_dir:\$PATH\""
	;;
--install)
	echo "git $installed_version is installed at $bin_dir"
	echo
	echo "Put it first on PATH for this shell:"
	echo "  eval \"\$(sh tools/paperclip-git.sh --activate)\""
	;;
esac
