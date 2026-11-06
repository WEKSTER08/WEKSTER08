#!/usr/bin/env bash
# Two-device sync demo against a relay (default: local relay on 8787).
# Start the relay first:  npm run relay     (or: docker compose up)
# Then:                   scripts/demo.sh   [RELAY_URL]
set -euo pipefail
cd "$(dirname "$0")/.."
RELAY=${1:-http://localhost:8787}
V=scripts/vox
D=.devices/demo
rm -rf "$D"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

step "phone starts a new sync space"
OUT=$($V --dir $D/phone init --relay "$RELAY" --name phone); echo "$OUT"
CODE=$(echo "$OUT" | grep -o 'vv1\.[A-Za-z0-9_-]*')
$V --dir $D/phone folder add Books
$V --dir $D/phone folder add "Project Hail Mary" --parent Books
$V --dir $D/phone note add "Survival mechanics" "Astrophage eats light" --folder "Project Hail Mary"
$V --dir $D/phone note add "Call dentist"
$V --dir $D/phone sync

step "laptop joins with the pairing code"
$V --dir $D/laptop join "$CODE" --relay "$RELAY" --name laptop
$V --dir $D/laptop ls

step "while offline from each other: laptop files the dentist note, phone deletes Books"
$V --dir $D/laptop folder add Health
$V --dir $D/laptop note mv "Call dentist" --folder Health
$V --dir $D/phone folder rm Books

step "both sync"
$V --dir $D/laptop sync; $V --dir $D/phone sync; $V --dir $D/laptop sync

step "phone";  $V --dir $D/phone ls
step "laptop"; $V --dir $D/laptop ls
echo
echo "Both devices match. 'Survival mechanics' survived the folder delete and is in the Inbox."
