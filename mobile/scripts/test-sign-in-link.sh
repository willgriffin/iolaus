#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_file=$(mktemp /tmp/jobgeni-sign-in-link.XXXXXX.swift)
trap 'rm -f "$source_file"' EXIT
cat "$root/ios/App/App/SignInLink.swift" "$root/scripts/sign-in-link.test.swift" > "$source_file"
swift "$source_file"
