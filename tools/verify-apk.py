"""
Check a *published* APK, independently of the build that made it.

    python3 tools/verify-apk.py tanks.apk [marker ...]

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

The Hermes magic is read and printed rather than asserted from memory. Writing
it out from memory once got it wrong and reported a real Hermes bundle as plain
JavaScript.
"""
import re
import sys
import zipfile

HERMES_MAGIC = bytes.fromhex('c61fbc03c103191f')

# (dex signature, what it is). The native half, which no JS check can see.
NATIVE = [
    ('Lexpo/modules/tankslan/TanksLanModule;', 'WiFi listening socket'),
    ('Lexpo/modules/tanksble/TanksBleModule;', 'Bluetooth radio'),
]

# (symbol, what it means, expected-present). bleAdapter is expected ABSENT until
# something in JS imports it -- Metro drops what nothing references, so the
# native module can ship while the radio stays unreachable from JS. That gap is
# the current known state, not a regression, and this prints it either way
# rather than failing on it.
JS_SYMBOLS = [
    ('TanksLan', 'native TCP transport binding', True),
    ('TanksBle', 'radio JS binding', False),
    ('bleAdapter', 'BLE adapter module', False),
]


def main(path, markers):
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
    for sym, what, expect in JS_SYMBOLS:
        u8 = bundle.count(sym.encode('utf-8'))
        u16 = bundle.count(sym.encode('utf-16-le'))
        found = bool(u8 or u16)
        state = 'ok     ' if found == expect else 'CHANGED'
        note = '' if found == expect else ('  <- now present' if found else '  <- now absent')
        print(f"  {state}  utf8={u8:<3} utf16={u16:<3} {sym:<12} ({what}){note}")

    if markers:
        print("\n-- markers (searched in the JS bundle, then the dex) --")
        for m in markers:
            b = bundle.count(m.encode('utf-8')) + bundle.count(m.encode('utf-16-le'))
            d = dex.count(m.encode('utf-8'))
            where = 'bundle' if b else ('dex' if d else '')
            print(f"  {'ok     ' if b or d else 'MISSING'}  {m!r} {f'in {where}' if where else ''}")

    libs = sorted({re.sub(r'lib/([^/]+)/.*', r'\1', n) for n in names if n.startswith('lib/')})
    print(f"\nABIs: {libs}")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__.strip())
    main(sys.argv[1], sys.argv[2:])
