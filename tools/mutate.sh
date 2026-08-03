#!/bin/bash
#
# Mutation harness.
#
# Break something on purpose, run a command, put it back. If the command still
# passes, the tests do not actually cover the thing that was broken.
#
#   tools/mutate.sh <file> "<command>" "<old text>" "<new text>" ["label"]
#
# Two properties this exists to guarantee, both learned the hard way:
#
# 1. THE EDIT IS CONFIRMED. Every mutation here used to be a `perl -0pi -e s///`
#    against source text, and a pattern that matched nothing failed silently --
#    so the run reported "the code survived the mutation" when nothing had been
#    mutated at all. Two spawn-fairness mutations "survived" that way before I
#    noticed I had miscounted the dots in a row of map text. A harness that
#    cannot tell "the code survived" from "I changed nothing" is worse than no
#    harness, because it manufactures false confidence in a test.
#
#    So: exact string replacement, and a non-zero exit if the text is not
#    found. No regex, nothing to miscount.
#
# 2. THE FILE COMES BACK. Restored from a copy via a trap, never an `&&` chain
#    -- a failed `cd` in one of those once left a source file half-mutated on
#    disk, which is a far worse outcome than a bad test result. The trap alone
#    was not enough: a command of the form `cd packages/core && npm test` moved
#    the shell out from under a relative FILE and the restoring `cp` failed, so
#    the path is resolved up front and the command runs in a subshell.
#
# Exit code is the mutation's verdict, not the command's:
#   0  the command failed, so the mutation was caught  (what you want)
#   1  the command passed, so nothing covers this
#   9  the text was not found -- the mutation never applied, result meaningless

set -u

if [ "$#" -lt 4 ]; then
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi

FILE=$1
COMMAND=$2
OLD=$3
NEW=$4
LABEL=${5:-mutation}

[ -f "$FILE" ] || { echo "mutate: no such file: $FILE" >&2; exit 2; }

# Absolute, because the command under test is free to cd -- and a relative
# path in the restore is how the file gets left mutated on disk.
FILE=$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")

BACKUP=$(mktemp "${TMPDIR:-/tmp}/mutate.XXXXXX")
cp "$FILE" "$BACKUP"
restore() {
  cp "$BACKUP" "$FILE"
  rm -f "$BACKUP"
}
trap restore EXIT INT TERM

python3 - "$FILE" "$OLD" "$NEW" <<'PY' || exit 9
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path).read()
if old not in text:
    print(f"  !! not found in {path}, so nothing was mutated:\n     {old!r}")
    sys.exit(1)
open(path, 'w').write(text.replace(old, new, 1))
PY

echo "=== $LABEL ==="
# In a subshell, so a `cd` in the command cannot follow us back out.
if ( eval "$COMMAND" ); then
  echo "--- SURVIVED: nothing catches this ---"
  exit 1
fi
echo "--- caught ---"
exit 0
