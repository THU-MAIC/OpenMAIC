import 'server-only';
import { MAX_COMMAND_BYTES } from '@/lib/sandbox/types';
import { sandboxInvalid } from '@/lib/sandbox/errors';
import { safeProjectPath } from '@/lib/pbl/v3/package-policy';

export const JAVA_APPLICATION_CLASSES = '/tmp/pbl-project-build';

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function checkedCommand(command: string) {
  if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES)
    throw sandboxInvalid(
      'Application arguments or source paths exceed the sandbox 32 KiB command limit.',
    );
  return command;
}
export function applicationLaunchCommand(argv: string[], javaSources?: readonly string[]) {
  if (argv[0] === 'java') {
    if (
      argv[1] !== '-cp' ||
      argv[2] !== JAVA_APPLICATION_CLASSES ||
      !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(argv[3] ?? '') ||
      !javaSources?.length ||
      javaSources.some((name) => !safeProjectPath(name) || !name.endsWith('.java')) ||
      !javaSources.some(
        (name) =>
          name === argv[3].replaceAll('.', '/') + '.java' ||
          name.endsWith('/' + argv[3].replaceAll('.', '/') + '.java'),
      )
    )
      throw sandboxInvalid(
        'Java applications require declared sources and a main class in the fixed build directory.',
      );
    const data = Buffer.from(
      JSON.stringify({ argv, sources: [...new Set(javaSources)].sort() }),
    ).toString('base64');
    const script = `import base64,json,os,shutil,subprocess,sys,tempfile
c=json.loads(base64.b64decode('${data}'))
if not shutil.which('javac') or not shutil.which('java'):
 sys.exit('Java preview requires a JDK with java and javac in the sandbox template.')
classes=os.path.join(tempfile.gettempdir(),'pbl-java-preview')
if os.path.exists(classes): shutil.rmtree(classes)
os.mkdir(classes)
subprocess.run(['javac','-encoding','UTF-8','-classpath',classes,'-d',classes,*['./'+p for p in c['sources']]],check=True)
c['argv'][2]=classes
os.execvp('java',c['argv'])`;
    return checkedCommand(`exec python3 -I -B -c ${quote(script)}`);
  }
  return checkedCommand(`exec ${argv.map(quote).join(' ')}`);
}

/** A fixed read-only GET plus hashes of permitted sources; no browser-provided URL or shell. */
export function applicationProbeCommand(paths: string[], port: number, healthPath: string) {
  const config = Buffer.from(
    JSON.stringify({ paths: paths.filter((path) => path !== 'PLAN.md'), port, healthPath }),
  ).toString('base64');
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
