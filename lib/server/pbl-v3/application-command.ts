import 'server-only';
import { MAX_COMMAND_BYTES } from '@/lib/sandbox/types';
import { sandboxInvalid } from '@/lib/sandbox/errors';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function checkedCommand(command: string) {
  if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES)
    throw sandboxInvalid(
      'Application arguments or source paths exceed the sandbox 32 KiB command limit.',
    );
  return command;
}
export function applicationLaunchCommand(argv: string[]) {
  return checkedCommand(`exec ${argv.map(quote).join(' ')}`);
}

/** A fixed read-only GET plus hashes of permitted sources; no browser-provided URL or shell. */
export function applicationProbeCommand(paths: string[], port: number, healthPath: string) {
  const config = Buffer.from(JSON.stringify({ paths, port, healthPath })).toString('base64');
  const script = `import base64,hashlib,json,pathlib,urllib.request,urllib.error
c=json.loads(base64.b64decode('${config}'))
h=hashlib.sha256(); root=pathlib.Path.cwd().resolve(); total=0
for name in c['paths']:
 p=root/name
 if not p.resolve().is_relative_to(root): raise ValueError('Source path escaped workspace')
 data=p.read_bytes(); total+=len(data)
 if total>1048576: raise ValueError('Source size limit exceeded')
 h.update(name.encode()+b'\\0'+data+b'\\0')
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs): return None
out={'sourceHash':h.hexdigest()}
try:
 with urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect()).open('http://127.0.0.1:'+str(c['port'])+c['healthPath'],timeout=1.5) as response:
  out['httpStatus']=response.status
except urllib.error.HTTPError as error: out['httpStatus']=error.code
except (urllib.error.URLError,TimeoutError,OSError): pass
print(json.dumps(out))`;
  return checkedCommand(`python3 -I -B -c ${quote(script)}`);
}
