#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Invocation trust is supplied by an external root-protected bootstrap.
set -eu

INSTALL=/private/var/db/better-workflows/runtime-verifier-v2
NODE=$INSTALL/node
LAUNCHER=$INSTALL/runtime-qualification-launch-v2.sh
MANIFEST=$INSTALL/bootstrap-v2.json
BUNDLE=$INSTALL/bundle
GATE=$BUNDLE/plugins/better-workflows/scripts/runtime-qualification-gate-v2.mjs
PATH=/usr/bin:/bin
LC_ALL=C
LANG=C
export PATH LC_ALL LANG

hold() { /usr/bin/printf '%s\n' 'Runtime V2 launcher HOLD' >&2; exit 1; }
check_one() {
  one_path=$1
  one_kind=$2
  [ ! -L "$one_path" ] || hold
  one_meta=$(/usr/bin/stat -f '%u %Lp %l' "$one_path" 2>/dev/null) || hold
  one_uid=${one_meta%% *}
  one_tail=${one_meta#* }
  one_mode=${one_tail%% *}
  one_links=${one_tail##* }
  [ "$one_uid" = 0 ] || hold
  case "$one_mode" in ''|*[!0-7]*) hold ;; esac
  one_mode_num=$((0$one_mode))
  [ $((one_mode_num & 022)) -eq 0 ] || hold
  [ $((one_mode_num & 07000)) -eq 0 ] || hold
  one_listing=$(/bin/ls -lde "$one_path" 2>/dev/null) || hold
  case "$one_listing" in *'
'*) hold ;; esac
  one_mode_word=${one_listing%% *}
  case "$one_mode_word" in *@) one_mode_word=${one_mode_word%@} ;; esac
  case "$one_mode_word" in
    [d-][rwxStTs-][rwxStTs-][rwxStTs-][rwxStTs-][rwxStTs-][rwxStTs-][rwxStTs-][rwxStTs-][rwxStTs-]) ;;
    *) hold ;;
  esac
  # macOS ls uses + for ACLs and @ for extended attributes; @ is allowed.
  if [ "$one_kind" = directory ]; then
    [ -d "$one_path" ] || hold
  else
    [ -f "$one_path" ] || hold
    [ "$one_links" = 1 ] || hold
  fi
}
check_chain() {
  chain_target=$1
  chain_kind=$2
  case "$chain_target" in /*) ;; *) hold ;; esac
  check_one / directory
  chain_current=/
  chain_rest=${chain_target#/}
  while [ -n "$chain_rest" ]; do
    case "$chain_rest" in
      */*) chain_part=${chain_rest%%/*}; chain_rest=${chain_rest#*/} ;;
      *) chain_part=$chain_rest; chain_rest= ;;
    esac
    [ -n "$chain_part" ] && [ "$chain_part" != . ] && [ "$chain_part" != .. ] || hold
    chain_current=${chain_current%/}/$chain_part
    if [ -n "$chain_rest" ] || [ "$chain_kind" = directory ]; then check_one "$chain_current" directory
    else check_one "$chain_current" file
    fi
  done
}
sha_from_manifest() {
  value=$(/usr/bin/plutil -extract "$1" raw -o - "$MANIFEST" 2>/dev/null) || hold
  case "$value" in ''|*[!0-9a-f]*) hold ;; esac
  [ "${#value}" -eq 64 ] || hold
  /usr/bin/printf '%s' "$value"
}
check_sha() {
  file=$1
  expected=$2
  output=$(/usr/bin/shasum -a 256 "$file" 2>/dev/null) || hold
  actual=${output%% *}
  [ "$actual" = "$expected" ] || hold
}
check_size() {
  bounded_size=$(/usr/bin/stat -f '%z' "$1" 2>/dev/null) || hold
  case "$bounded_size" in ''|*[!0-9]*) hold ;; esac
  [ "$bounded_size" -gt 0 ] && [ "$bounded_size" -le "$2" ] || hold
}

[ "$#" -eq 0 ] || hold
[ -n "${HOME-}" ] || hold
case "$HOME" in /*) ;; *) hold ;; esac
case "${SBW_RELEASE_REVISION-}" in ''|*[!0-9a-f]*) hold ;; esac
[ "${#SBW_RELEASE_REVISION}" -eq 40 ] || hold
case "${SBW_CONFORMANCE_RUN_ID-}" in ''|*[!0-9]*) hold ;; esac
[ "$SBW_CONFORMANCE_RUN_ID" != 0 ] || hold
case "${SBW_PUBLIC_SOURCE_ROOT-}" in /*) ;; *) hold ;; esac
case "${SBW_RUNTIME_ARTIFACT_DIR-}" in /*) ;; *) hold ;; esac
case "${SBW_STATE_ROOT-}" in /*) ;; *) hold ;;
esac

# Check every parent, and the fixed physical leaf, under the C locale.
check_chain "$INSTALL" directory
check_chain "$NODE" file
check_chain "$LAUNCHER" file
check_chain "$MANIFEST" file
check_chain "$BUNDLE" directory
check_chain "$GATE" file
check_size "$MANIFEST" 65536
check_size "$NODE" 536870912
check_size "$LAUNCHER" 1048576
check_size "$GATE" 67108864
/usr/bin/plutil -lint "$MANIFEST" >/dev/null 2>&1 || hold
NODE_SHA=$(sha_from_manifest nodeSha256)
GATE_SHA=$(sha_from_manifest gateSha256)
LAUNCHER_SHA=$(sha_from_manifest launcherSha256)
check_sha "$NODE" "$NODE_SHA"
check_sha "$GATE" "$GATE_SHA"
check_sha "$LAUNCHER" "$LAUNCHER_SHA"

cd /
# No GH_TOKEN/GITHUB_TOKEN is placed in argv or copied into the clean env.
# gh must use already-configured authentication under this exact existing HOME;
# missing auth fails closed in the verifier.
exec /usr/bin/env -i \
  PATH=/usr/bin:/bin LC_ALL=C LANG=C HOME="$HOME" \
  SBW_RELEASE_REVISION="$SBW_RELEASE_REVISION" \
  SBW_CONFORMANCE_RUN_ID="$SBW_CONFORMANCE_RUN_ID" \
  SBW_PUBLIC_SOURCE_ROOT="$SBW_PUBLIC_SOURCE_ROOT" \
  SBW_RUNTIME_ARTIFACT_DIR="$SBW_RUNTIME_ARTIFACT_DIR" \
  SBW_STATE_ROOT="$SBW_STATE_ROOT" \
  "$NODE" "$GATE"
