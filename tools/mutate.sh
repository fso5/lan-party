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
# 3. THE COMMAND IS MEANINGFUL. "Caught" is inferred from the command failing,
#    so a command that was already failing reports every mutation as caught --
#    including ones that in fact survived. So the command is run once against
#    the pristine file first, and a verdict is refused if that does not pass.
#
# 4. THE COMMAND READS THIS FILE. Passing on clean source is not enough: a test
#    glob that matches nothing makes node print "tests 0" and exit 0, so every
#    mutation under it comes back SURVIVED. So the file is replaced with
#    something unparseable and the command must fail. If it does not, it never
#    loaded the file, and no verdict about it means anything.
#
#    Set MUTATE_SKIP_CHECKS=1 to skip 3 and 4 when you have just run them.
#
# KNOWN LIMIT, and it is not guarded: if the command builds, "caught" can mean
# the compiler objected rather than a test failing. core's tsconfig sets
# noUnusedLocals, so deleting the one use of a constant reports "caught" purely
# because the constant is now unused -- which says nothing about coverage. It
# cost me a wrong conclusion: `const base = age > INPUT_STALE_TICKS ? ... ` was
# "caught" that way while setting the same constant to a million survived, two
# behaviourally identical mutations with opposite verdicts. When a mutation
# could plausibly change what compiles, prefer one that cannot -- change a
# value rather than remove a use -- or read the command's output rather than
# just its exit code.
#
# Exit code is the mutation's verdict, not the command's:
#   0  the command failed, so the mutation was caught  (what you want)
#   1  the command passed, so nothing covers this
#   3  the command fails on unmutated source -- fix the command, no verdict
#   4  the command ignores this file entirely -- fix the command, no verdict
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

# Property 3: THE COMMAND MEANS SOMETHING.
#
# "Caught" is inferred from the command failing, so a command that fails on
# its own -- before any mutation -- reports every mutation as caught. Three
# times in one session I passed a test path relative to packages/core while
# standing in the repo root; each run printed "caught" and each was a verdict
# about my typing. One of them hid a mutation that had genuinely survived, so
# this does not merely waste a run, it inverts the answer.
#
# Nothing about the mutated file is trusted here: the baseline runs against
# the pristine copy, then the mutation is reapplied. Costs one extra run of
# the command, which is worth strictly more than a confident wrong answer.
if [ "${MUTATE_SKIP_CHECKS:-${MUTATE_SKIP_BASELINE:-0}}" != "1" ]; then
  cp "$BACKUP" "$FILE"
  if ! ( eval "$COMMAND" ) >/dev/null 2>&1; then
    echo "--- BASELINE FAILED: the command does not pass on unmutated source ---"
    echo "    Any verdict from it would be meaningless. Check the command runs"
    echo "    from this directory ($(pwd)) -- a test path relative to the wrong"
    echo "    package is the usual cause."
    exit 3
  fi

  # Property 4: THE COMMAND EXERCISES THIS FILE.
  #
  # Passing on clean source is not enough. `npx tsx --test test/*.test.ts` run
  # from the repo root matches no files, so node reports "tests 0" and exits 0
  # -- and every mutation under it comes back SURVIVED. That is the opposite
  # failure to property 3 and the more insidious one: a false alarm sends you
  # writing tests for behaviour that was already covered.
  #
  # A syntax error is the one edit guaranteed to be noticed by anything that
  # actually loads the file. If the command still passes with this file
  # unparseable, it never read it, and no verdict about it is worth having.
  printf '!!!mutate.sh sensitivity probe -- not valid source!!!\n' > "$FILE"
  if ( eval "$COMMAND" ) >/dev/null 2>&1; then
    cp "$BACKUP" "$FILE"
    echo "--- INSENSITIVE: the command passes with $FILE syntactically broken ---"
    echo "    So it never loads that file, and SURVIVED would mean nothing."
    echo "    Usual causes: a glob that matched no test files (node exits 0 on"
    echo "    'tests 0'), the wrong package, or a build step that is not rerun."
    exit 4
  fi
  cp "$BACKUP" "$FILE"

  python3 - "$FILE" "$OLD" "$NEW" <<'PY' || exit 9
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path).read()
if old not in text:
    print(f"  !! not found in {path} on reapply:\n     {old!r}")
    sys.exit(1)
open(path, 'w').write(text.replace(old, new, 1))
PY
fi

# In a subshell, so a `cd` in the command cannot follow us back out.
if ( eval "$COMMAND" ); then
  echo "--- SURVIVED: nothing catches this ---"
  exit 1
fi
echo "--- caught ---"
exit 0
