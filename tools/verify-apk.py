"""
Check a *published* APK, independently of the build that made it.

    python3 tools/verify-apk.py tanks.apk [marker ...]
    python3 tools/verify-apk.py tanks.apk --page packages/proto/dist/tanks-proto.html
    python3 tools/verify-apk.py --selftest

`--page` is the check worth running. Everything else here asks whether the APK
contains *a* page; that asks whether it contains *this* one, against a local
build of the commit you think shipped. The page build is reproducible -- two
runs of the same commit are byte-identical -- so a difference means the
artifact is stale, not that the build wandered.

Check out that commit before building the page to compare against. `build.mjs`
stamps the short sha into the page, so *every* commit changes it, and comparing
a published APK against a working tree one commit further on reports STALE over
a seven-character marker. The bare run tells you which commit to check out: it
prints the page it found, and the stamp is in there.

`--selftest` exercises the extractor without a 42MB download, which is the only
reason it gets exercised at all.

The Android workflow already checks the bundle it just built. This is for the
other question: does the artifact people actually download carry what the source
says it should. Deliberately not the CI script -- that one would agree with
itself if its greps were subtly wrong. This asks the same questions a different
way and prints numbers rather than a verdict.

Two ways this check can lie, both hit for real:

1. **Hermes stores most strings single-byte.** UTF-16 only when a string needs
   it. So a naive UTF-16 search finds nothing and reads as "the code is
   missing". Both encodings are counted below, and a hit in either is a hit.

2. **A string split across a `+` never exists as one literal.** Searching for
   "cannot carry a coordinate past" reported a guard missing from the bundle
   that was plainly there, because the source reads

       `... the wire format cannot carry a ` +
       `coordinate past ${MAX_WIRE_POS} tiles ...`

   and the bundler kept the two halves apart. A marker must be a fragment that
   survives concatenation -- keep them short, and inside one literal.

3. **The page the host serves is base64 inside the bundle.** `gamePage.ts`
   embeds it as one base64 literal, so nothing in it can be found by searching
   the bundle -- a marker plainly present in the page reads as MISSING. That
   page is what every other phone in the room is handed, so it is decoded and
   searched separately below. Checked once by hand before this existed: the
   shipped APK did carry the current page.

The Hermes magic is read and printed rather than asserted from memory. Writing
it out from memory once got it wrong and reported a real Hermes bundle as plain
JavaScript.
"""
import base64
import re
import sys
import zipfile

HERMES_MAGIC = bytes.fromhex('c61fbc03c103191f')

# "<!doctype html>" base64-encoded. The page the host phone serves to everyone
# else is embedded as one base64 string literal (see gamePage.ts), so its
# contents are invisible to a search of the bundle -- a marker that is plainly
# in the page reads as MISSING. This is how to actually look inside it.
PAGE_PREFIX = b'PCFkb2N0eXBlIGh0bWw+'

# (dex signature, what it is). The native half, which no JS check can see.
NATIVE = [
    ('Lexpo/modules/tankslan/TanksLanModule;', 'WiFi listening socket'),
    ('Lexpo/modules/tanksble/TanksBleModule;', 'Bluetooth radio'),
]

# (symbol, what it means, expected-present, note if it appears, note if it goes).
#
# bleAdapter is expected ABSENT until something in JS imports it -- Metro drops
# what nothing references, so the native module can ship while the radio stays
# unreachable from JS. That gap is the current known state, not a regression,
# and this prints it either way rather than failing on it.
#
# Which is why each row prints the *fact* first and the comparison second. An
# earlier version printed one word, computed as `found == expect`, so the row
# for the radio read
#
#     ok       utf8=0   utf16=0   TanksBle     (radio JS binding)
#
# -- "ok" against a count of zero, on the one line somebody would quote as
# proof the radio ships. And on the day the lobby imports the adapter, the same
# column would have said CHANGED about the thing everyone was waiting for.
# Neither is a lie exactly; both are the wrong word in the place it gets read.
#
# Two notes per row rather than one, chosen by the fact rather than by which
# direction is currently surprising. One note per row read correctly right up
# until the first draft of this change was tested by flipping an expectation --
# at which point the tool printed "the radio is reachable from JS now" beside
# `absent`. Whoever flips `expect` would have had to remember to rewrite the
# sentence too, and a tool whose job is not lying about an APK should not have
# that as a manual step.
JS_SYMBOLS = [
    ('TanksLan', 'native TCP transport binding', True,
     'something new is pulling in the LAN binding',
     'the WiFi path has lost its JS binding -- hosting over WiFi cannot work'),
    ('TanksBle', 'radio JS binding', False,
     'the radio is reachable from JS now, which is the goal -- update the expectation here',
     'the radio was reachable from JS and is not any more'),
    ('bleAdapter', 'BLE adapter module', False,
     'Metro is bundling the adapter now, which is the goal -- update the expectation here',
     'Metro has stopped bundling the adapter -- nothing imports it any more'),
]


def looks_like_the_page(text):
    """Decoded bytes that could be the HTML page, rather than bundle spill."""
    try:
        s = text.decode('utf-8')
    except UnicodeDecodeError:
        return False
    # Random bytes that happen to decode are still not a text document.
    return not any(ord(c) < 32 and c not in '\t\n\r' for c in s)


def embedded_page(bundle):
    """The served page, decoded, or None if it is not in there.

    Not a nicety: this is what every other phone in the room is handed. A build
    where it went missing or went stale would pass every other check here, and
    fail as a blank page on somebody else's handset.

    ## Where the literal ends has to be worked out, not matched

    Hermes stores strings in a table with no quotes around them, so there is no
    delimiter to look for -- which is why this matches a run of base64
    characters. That run does not stop where the string does: it keeps going
    into whatever the bundle holds next, for as long as those bytes happen to
    be base64 characters.

    Caught by comparing a published APK against a local build of the same
    commit: identical for all 200007 bytes, then six bytes of garbage this
    function had invented (`~\\xe9\\xdc\\xb6*'`) from eight characters of
    spill. Six bytes is harmless. Being wrong about where the page ends is not,
    because the spill can also make the run undecodable, and this function then
    returns None and the tool reports MISSING for a perfectly good APK -- a
    false alarm from the one check that exists to catch a missing page.

    So: take the longest prefix, on a base64 boundary, that decodes to
    something that could be an HTML document. The page is UTF-8 text and the
    spill is effectively random bytes, so the first prefix that survives both
    tests is almost always the string as it was stored.

    Almost. Returns (page, exact). When the literal carried padding the answer
    is provable -- padding can only appear in the final group, so the string
    ends there. Without padding it is not: spill that happens to decode to
    ordinary text is indistinguishable from more page. `Zm9vYmFy` decodes to
    `foobar`, which is valid UTF-8 with no control characters, and the
    self-test caught it surviving within a minute of that self-test existing.

    Trimming back to the document's last tag was tried and is worse. It fixes
    the spill at the cost of silently truncating any page that does not end in
    one, and a tool that under-reports the page is lying about content rather
    than about a byte count. So the bias is deliberate: never lose page, and
    say plainly when the tail is not provable. `--page` settles it exactly.
    """
    i = bundle.find(PAGE_PREFIX)
    if i < 0:
        return None, False
    run = re.match(rb'[A-Za-z0-9+/=]+', bundle[i:]).group(0)

    # Padding can only appear in the final group of a base64 literal, so when
    # it is there it settles the question outright: the literal ends at the end
    # of that group.
    pad = run.find(b'=')
    exact = pad >= 0
    if exact:
        run = run[:pad + (4 - pad % 4)]

    for end in range(len(run) - len(run) % 4, 0, -4):
        try:
            out = base64.b64decode(run[:end])
        except Exception:
            continue
        if looks_like_the_page(out):
            return out, exact
    return None, False


def selftest():
    """Prove the extractor never loses page, and is exact when it can be.

    This tool exists to not lie about an APK, and it lied once -- see
    embedded_page. A check that cannot be run without a 42MB download is a
    check that stops being run, so the awkward part is exercised directly:
    every page length modulo 3, which covers all three base64 padding cases,
    each followed by bytes that keep the character run going.

    Two different claims, because the extractor can only prove one of them:

      - **never truncated.** Unconditional. Under-reporting the page is the
        failure that matters, because it is a lie about content rather than
        about a byte count, and it is what a cleverer end-of-string heuristic
        cost when it was tried.
      - **exact.** Only when the literal carried padding. Without it, spill
        that decodes to ordinary text cannot be told from more page, and the
        honest thing is to say so rather than to guess and be believed.
    """
    import os

    bad = 0
    for extra in range(3):
        page = b'<!doctype html>\n<title>x</title>\n' + b'y' * (300 + extra)
        literal = base64.b64encode(page)
        for spill in [b'', b'AAAA', b'Zm9vYmFy', os.urandom(64), b'A' * 200]:
            got, exact = embedded_page(literal + spill)
            whole = got is not None and got.startswith(page)
            claim = (got == page) if exact else whole
            bad += not (whole and claim)
            extraN = len(got) - len(page) if got else None
            print(f"  {'ok     ' if whole and claim else 'WRONG  '}  len%3={len(page) % 3}  "
                  f"spill={len(spill):<3}  {'exact' if exact else 'tail unprovable'}, "
                  f"{'whole page kept' if whole else 'PAGE TRUNCATED'}, +{extraN} bytes")

    # And the case that matters most: no page at all must read as no page,
    # rather than as some other base64-looking run in the bundle.
    got, _ = embedded_page(b'\x00\x01not a page here AAAABBBB')
    print(f"  {'ok     ' if got is None else 'WRONG  '}  a bundle with no page reads as MISSING")
    bad += got is not None

    print('\nself-test FAILED' if bad else '\nself-test passed')
    return 1 if bad else 0


def main(path, markers, expect_page=None):
    apk = zipfile.ZipFile(path)
    names = apk.namelist()
    bundle = apk.read('assets/index.android.bundle')
    dex = b''.join(
        apk.read(n) for n in sorted(n for n in names if n.startswith('classes') and n.endswith('.dex'))
    )

    print(f"{path}: {len(names)} entries")
    print(f"JS bundle: {len(bundle):,} bytes")
    print(f"first 8 bytes: {bundle[:8].hex(' ')}")
    print(f"Hermes bytecode: {bundle[:8] == HERMES_MAGIC}")
    print(f"dex: {len(dex):,} bytes")

    print("\n-- native classes (dex) --")
    for sig, what in NATIVE:
        n = dex.count(sig.encode())
        print(f"  {'ok     ' if n else 'MISSING'}  {sig:<44} x{n}  ({what})")

    print("\n-- JS symbols (both encodings; see the note on Hermes above) --")
    for sym, what, expect, on_appear, on_vanish in JS_SYMBOLS:
        u8 = bundle.count(sym.encode('utf-8'))
        u16 = bundle.count(sym.encode('utf-16-le'))
        found = bool(u8 or u16)
        # The fact, then the comparison. Never one word standing for both.
        fact = 'present' if found else 'absent '
        verdict = 'as expected' if found == expect else 'CHANGED    '
        print(f"  {fact}  {verdict}  utf8={u8:<3} utf16={u16:<3} {sym:<12} ({what})")
        if found != expect:
            print(f"           -> {on_appear if found else on_vanish}")

    page, exact = embedded_page(bundle)
    print("\n-- the page the host serves to every other phone --")
    if page is None:
        print("  MISSING  no base64 page literal found in the bundle")
    else:
        note = '' if exact else '  (+/- a few bytes of tail; see embedded_page)'
        print(f"  ok       {len(page):,} bytes, starts {page[:15]!r}{note}")

    # "A page is in there" is the weaker question. This is the real one: is it
    # *this* page. Build one locally (node packages/proto/build.mjs) and pass
    # it with --page, and a shipped APK that went stale says so instead of
    # looking healthy. The build is reproducible -- two runs of the same commit
    # are byte-identical -- so a mismatch means the artifact, not the build.
    if expect_page is not None:
        want = open(expect_page, 'rb').read()
        if page == want:
            print(f"  ok       and identical to {expect_page}")
        elif page is None:
            print(f"  STALE    nothing to compare against {expect_page}")
        else:
            n = min(len(page), len(want))
            first = next((i for i in range(n) if page[i] != want[i]), n)
            print(f"  STALE    differs from {expect_page}: shipped {len(page):,} bytes, "
                  f"local {len(want):,}, first difference at byte {first:,}")

    if markers:
        print("\n-- markers (JS bundle, then dex, then the served page) --")
        for m in markers:
            b = bundle.count(m.encode('utf-8')) + bundle.count(m.encode('utf-16-le'))
            d = dex.count(m.encode('utf-8'))
            g = page.count(m.encode('utf-8')) if page else 0
            where = 'bundle' if b else ('dex' if d else ('served page' if g else ''))
            print(f"  {'ok     ' if b or d or g else 'MISSING'}  {m!r} {f'in {where}' if where else ''}")

    libs = sorted({re.sub(r'lib/([^/]+)/.*', r'\1', n) for n in names if n.startswith('lib/')})
    print(f"\nABIs: {libs}")


if __name__ == '__main__':
    argv = sys.argv[1:]

    if '--selftest' in argv:
        print('-- extractor self-test --')
        sys.exit(selftest())

    expect = None
    if '--page' in argv:
        i = argv.index('--page')
        if i + 1 >= len(argv):
            sys.exit('--page needs a file')
        expect = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]

    if not argv:
        sys.exit(__doc__.strip())
    main(argv[0], argv[1:], expect)
