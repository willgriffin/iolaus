#!/usr/bin/env bash

set -euo pipefail

if /usr/bin/unshare --user --map-root-user --net -- true; then
  exit 0
fi

profile_file="$(mktemp)"
cleanup_profile() {
  rm -f -- "${profile_file}"
}
trap cleanup_profile EXIT

cat >"${profile_file}" <<'APPARMOR'
abi <abi/4.0>,
include <tunables/global>

profile iolaus-parity-unshare /usr/bin/unshare flags=(unconfined) {
  userns,
}
APPARMOR

sudo apparmor_parser -r "${profile_file}"
/usr/bin/unshare --user --map-root-user --net -- true
