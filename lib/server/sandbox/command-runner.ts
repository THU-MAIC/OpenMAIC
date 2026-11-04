import 'server-only';

/**
 * Small per-command supervisor, executed inside the sandbox (not a host daemon).
 * The exclusive claim file is the operation receipt. Retrying a lost start response
 * cannot execute the command twice. Output and status survive HTTP disconnections.
 * Requires Python 3 and POSIX process groups in the configured runtime template.
 */
export const COMMAND_RUNNER = String.raw`
import base64, json, os, selectors, signal, subprocess, sys, time
spec = json.loads(base64.b64decode(sys.argv[1]))
root = '/tmp/openmaic-commands/' + spec['id']
os.makedirs(root, mode=0o700, exist_ok=True)
try:
    claim = os.open(root + '/claimed', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(claim)
except FileExistsError:
    sys.exit(0)
state = {'id': spec['id'], 'state': 'starting', 'stdout': '', 'stderr': '',
         'exitCode': None, 'truncated': False}
def save():
    with open(root + '/status.tmp', 'w') as f:
        json.dump(state, f, ensure_ascii=False)
    os.replace(root + '/status.tmp', root + '/status.json')
save()
proc = None
sel = selectors.DefaultSelector()
out = {'stdout': bytearray(), 'stderr': bytearray()}
used = 0
def collect_output():
    remaining = 262144
    for k, v in out.items():
        if not v: continue
        encoded = v.decode('utf-8', errors='replace').encode('utf-8')
        if len(encoded) > remaining: state['truncated'] = True
        state[k] = encoded[:remaining].decode('utf-8', errors='ignore')
        remaining -= len(state[k].encode('utf-8'))
try:
    if os.path.exists(root + '/cancel'):
        state['state'] = 'cancelled'
    else:
        proc = subprocess.Popen(['/bin/sh', '-c', spec['command']], cwd=spec.get('cwd'),
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True)
        for stream, name in [(proc.stdout, 'stdout'), (proc.stderr, 'stderr')]:
            os.set_blocking(stream.fileno(), False)
            sel.register(stream, selectors.EVENT_READ, name)
        deadline = time.monotonic() + spec['timeoutMs'] / 1000
        state['state'] = 'running'
        save()
        last_save = time.monotonic()
        while True:
            cancelled = os.path.exists(root + '/cancel')
            timed_out = time.monotonic() >= deadline
            if cancelled or timed_out:
                state['state'] = 'cancelled' if cancelled else 'timed_out'
                break
            for key, mask in sel.select(0.1):
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    sel.unregister(key.fileobj)
                    key.fileobj.close()
                    continue
                take = min(len(data), max(0, 262144 - used))
                out[key.data].extend(data[:take])
                used += take
                if take < len(data): state['truncated'] = True
            if proc.poll() is not None and not sel.get_map():
                state['state'] = 'exited'
                break
            if time.monotonic() - last_save >= 0.3:
                collect_output()
                save()
                last_save = time.monotonic()
except Exception:
    state['state'] = 'failed'
    state['stderr'] = 'The command could not be started in this runtime.'
finally:
    if proc:
        # Terminate the command's entire ordinary process group, including children.
        try: os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        time.sleep(0.15)
        try: os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        state['exitCode'] = proc.wait()
    sel.close()
    collect_output()
    save()
`;

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
