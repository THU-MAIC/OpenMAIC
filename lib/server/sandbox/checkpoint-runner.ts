/** Streaming, deterministic tar. Extraction never delegates paths or links to tarfile.extract. */
const CHECKPOINT_BODY = String.raw`
import os, sys, stat, json, base64, hashlib, tarfile, tempfile, shutil
cfg=json.loads(base64.b64decode(sys.argv[3]))
roots=cfg['roots']; limit=cfg['maxBytes']; count_limit=cfg['maxFiles']
action,path=sys.argv[1:3]
def safe_path(p):
    if not isinstance(p,str) or not p or p.startswith('/') or len(p)>2048 or '\x00' in p or '\\' in p or any(x in ('','.','..') for x in p.split('/')): raise ValueError('path')
    return p
def check_root(root):
    parent=os.path.dirname(root)
    if os.path.realpath(parent)!=parent: raise ValueError('linked root parent')
    if os.path.lexists(root) and (os.path.islink(root) or not os.path.isdir(root)): raise ValueError('root')
def entries():
    used=0; count=0
    for r in roots:
        root=r['path']; check_root(root)
        yield r['name'],None,None
        if not os.path.exists(root): continue
        for parent,dirs,files in os.walk(root,followlinks=False):
            dirs[:]=sorted(n for n in dirs if n not in r['excludes'])
            for name in dirs+sorted(files):
                if name in r['excludes']: continue
                p=os.path.join(parent,name); info=os.lstat(p)
                rel=r['name']+'/'+safe_path(os.path.relpath(p,root))
                if stat.S_ISDIR(info.st_mode):
                    yield rel,None,None
                elif stat.S_ISREG(info.st_mode) and info.st_nlink==1:
                    used+=info.st_size
                    if used>limit: raise ValueError('byte limit')
                    yield rel,p,info
                else: raise ValueError('links or special files are not checkpointable')
                count+=1
                if count>count_limit: raise ValueError('entry limit')
def signature():
    h=hashlib.sha256()
    for rel,p,info in entries():
        h.update(json.dumps([rel,bool(info and info.st_mode & 0o111),info.st_size if info else -1],separators=(',',':')).encode())
        if p:
            with os.fdopen(os.open(p,os.O_RDONLY|os.O_NOFOLLOW),'rb') as f:
                actual=os.fstat(f.fileno())
                if (actual.st_ino,actual.st_size,actual.st_mtime_ns)!=(info.st_ino,info.st_size,info.st_mtime_ns): raise ValueError('changed')
                while True:
                    b=f.read(1048576)
                    if not b: break
                    h.update(b)
    return h.hexdigest()
if action=='export':
    before=signature()
    with open(path,'xb') as out:
        with tarfile.open(fileobj=out,mode='w|',format=tarfile.PAX_FORMAT) as tar:
            for rel,p,info in entries():
                member=tarfile.TarInfo(rel)
                member.uid=member.gid=member.mtime=0
                if p:
                    member.mode=0o700 if info.st_mode & 0o111 else 0o600; member.size=info.st_size
                    with os.fdopen(os.open(p,os.O_RDONLY|os.O_NOFOLLOW),'rb') as f:
                        actual=os.fstat(f.fileno())
                        if (actual.st_ino,actual.st_size,actual.st_mtime_ns)!=(info.st_ino,info.st_size,info.st_mtime_ns): raise ValueError('changed')
                        tar.addfile(member,f)
                else:
                    member.type=tarfile.DIRTYPE; member.mode=0o700; tar.addfile(member)
    if before!=signature(): raise ValueError('workspace changed during save')
elif action=='import':
    digest=sys.argv[4]
    h=hashlib.sha256()
    with open(path,'rb') as f:
        while True:
            b=f.read(1048576)
            if not b: break
            h.update(b)
    if h.hexdigest()!=digest: raise ValueError('archive checksum')
    stages={}; backups={}; seen=set(); used=0; count=0
    try:
        for r in roots:
            root=r['path']; check_root(root)
            os.makedirs(os.path.dirname(root),exist_ok=True)
            stages[r['name']]=tempfile.mkdtemp(prefix='.openmaic-stage-',dir=os.path.dirname(root))
        with tarfile.open(path,mode='r|') as tar:
            for member in tar:
                rel=safe_path(member.name.rstrip('/'))
                parts=rel.split('/'); name=parts[0]
                if name not in stages or rel in seen: raise ValueError('unexpected or duplicate path')
                seen.add(rel)
                if not (member.isdir() or member.isfile()) or member.sparse or member.linkname: raise ValueError('unsupported entry')
                if len(parts)==1:
                    if not member.isdir(): raise ValueError('root must be directory')
                    continue
                count+=1; used+=member.size
                if count>count_limit or used>limit or member.size<0: raise ValueError('limit')
                target=os.path.join(stages[name],*parts[1:])
                if member.isdir(): os.makedirs(target,exist_ok=True)
                else:
                    os.makedirs(os.path.dirname(target),exist_ok=True)
                    with tar.extractfile(member) as src, open(target,'xb') as dst:
                        shutil.copyfileobj(src,dst,1048576)
                    os.chmod(target,0o700 if member.mode & 0o111 else 0o600)
        if any(r['name'] not in seen for r in roots): raise ValueError('missing root')
        # Validate every root before replacing any. A retry can finish a partial
        # multi-root restore while the host keeps workspace_ready=false.
        for r in roots:
            root=r['path']; check_root(root)
            receipt=os.path.join(os.path.dirname(root),'.openmaic-receipt-'+r['name'])
            if os.path.lexists(receipt) and (os.path.islink(receipt) or not os.path.isfile(receipt)): raise ValueError('receipt')
            # Project restoration never overwrites an unrelated populated project.
            # Explicit extra roots may replace template defaults (application settings).
            if r['name']=='project' and os.path.isdir(root) and os.listdir(root):
                old=roots; roots=[r]; current=signature(); roots=[dict(r,path=stages[r['name']])]; wanted=signature(); roots=old
                if current!=wanted: raise ValueError('restore requires empty or identical project')
        for r in roots:
            root=r['path']; name=r['name']; parent=os.path.dirname(root)
            backup=os.path.join(parent,'.openmaic-backup-'+name+'-'+digest)
            check_root(backup)
            if os.path.exists(root):
                if os.path.exists(backup): shutil.rmtree(backup)
                os.replace(root,backup)
            backups[name]=backup
            os.replace(stages.pop(name),root)
            receipt=os.path.join(parent,'.openmaic-receipt-'+name)
            fd=os.open(receipt,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
            with os.fdopen(fd,'w') as f: f.write(digest)
        for backup in backups.values():
            if os.path.isdir(backup): shutil.rmtree(backup)
    finally:
        for stage in stages.values(): shutil.rmtree(stage,ignore_errors=True)
else: raise ValueError('action')
`;

/** A fixed protocol replaces raw tracebacks, paths and platform-dependent error text. */
export const CHECKPOINT_RUNNER = `
import sys, errno
try:
    exec(${JSON.stringify(CHECKPOINT_BODY)})
except Exception as error:
    code={'byte limit':'limit','entry limit':'limit','links or special files are not checkpointable':'unsupported','linked root parent':'unsupported','root':'unsupported','changed':'changed','workspace changed during save':'changed'}.get(str(error),'unavailable')
    if isinstance(error, PermissionError): code='permission'
    if isinstance(error, OSError) and error.errno==errno.ENOSPC: code='disk-full'
    print('OPENMAIC_CHECKPOINT_ERROR:'+code,file=sys.stderr)
    sys.exit(1)
`;
