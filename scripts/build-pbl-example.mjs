import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

// This example is authored on disk, independently of the built-in project catalog.
const repo = fileURLToPath(new URL('../', import.meta.url));
const source = join(repo, 'examples/pbl/future-self-lite');
const output = resolve(process.argv[2] ?? join(repo, 'dist/future-self-lite.maic.zip'));
const { version: appVersion } = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const files = {};
async function walk(directory, prefix = '') {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + item.name;
    if (item.isDirectory()) await walk(join(directory, item.name), name + '/');
    else if (item.isFile()) files[name] = await readFile(join(directory, item.name));
    else throw new Error(`Unsupported example resource: ${name}`);
  }
}
await walk(source);
const { id, version, definition } = JSON.parse(files['project.json'].toString('utf8'));
const index = Object.fromEntries(
  Object.keys(files)
    .sort()
    .map((name) => [name, { size: files[name].length, sha256: sha256(files[name]) }]),
);
const checksum = sha256(canonicalJson({ id, version, entrypoint: 'project.json', files: index }));
const root = `pbl/${checksum}`;
const manifest = {
  formatVersion: 2,
  requiredCapabilities: ['pbl-v3-projects@1'],
  exportedAt: new Date(0).toISOString(),
  appVersion,
  stage: {
    name: definition.title,
    description: '独立编写的最小 PBL 导入示例：一个函数、一个里程碑。',
    language: 'zh-CN',
    createdAt: 0,
    updatedAt: 0,
  },
  agents: [],
  scenes: [
    {
      type: 'pbl',
      title: definition.title,
      order: 0,
      content: { type: 'pbl', projectV3: { id, version, packageId: checksum } },
    },
  ],
  mediaIndex: {},
  pblProjects: [{ id, version, checksum, root, entrypoint: 'project.json', files: index }],
};
const zip = new JSZip();
const options = { date: new Date('2000-01-01T00:00:00Z') };
zip.file('manifest.json', JSON.stringify(manifest, null, 2) + '\n', options);
for (const name of Object.keys(files).sort()) zip.file(`${root}/${name}`, files[name], options);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log(`${output}\n${Object.keys(files).length} project files; ${root}`);
