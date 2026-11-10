import 'server-only';

/** Kill this PTY's POSIX session, including background jobs in other process groups. */
export const TERMINAL_CLEANUP = String.raw`
import os, signal, sys, time
pid = int(sys.argv[1])
marker = ('OPENMAIC_TERMINAL_ID=' + sys.argv[2]).encode()
def info(p):
    try:
        with open('/proc/%d/stat' % p) as f:
            fields = f.read().rsplit(')', 1)[1].split()
        return fields[0], int(fields[3])
    except (FileNotFoundError, ProcessLookupError): return None
original = info(pid)
if original is None: sys.exit(0)
with open('/proc/%d/environ' % pid, 'rb') as f:
    if marker not in f.read().split(b'\0'): sys.exit(2)
if original[1] != pid: sys.exit(3)
def members():
    result = []
    for entry in os.listdir('/proc'):
        if not entry.isdigit(): continue
        p = int(entry)
        data = info(p)
        if data and data[1] == pid and data[0] != 'Z': result.append(p)
    return result
for sig in (signal.SIGTERM, signal.SIGKILL):
    for p in members():
        try: os.kill(p, sig)
        except ProcessLookupError: pass
    time.sleep(0.2)
sys.exit(1 if members() else 0)
`;
