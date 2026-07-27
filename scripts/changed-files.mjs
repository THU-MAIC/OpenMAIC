import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

function git(args) {
  return execFileSync('git', ['-c', 'safe.directory=*', ...args], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
}

function eventRange() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !existsSync(eventPath)) return null;

  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  if (event.pull_request?.base?.sha && event.pull_request?.head?.sha) {
    return `${event.pull_request.base.sha}...${event.pull_request.head.sha}`;
  }
  if (event.before && event.after && !/^0+$/.test(event.before)) {
    return `${event.before}..${event.after}`;
  }
  if (event.after) return `${event.after}^..${event.after}`;
  return null;
}

/** Files added, copied, modified, or renamed by the current push/PR (or local edits). */
export function changedFiles() {
  const range = eventRange();
  const output = range
    ? git(['diff', '--name-only', '--diff-filter=ACMR', range])
    : git(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD']);

  return output ? output.split(/\r?\n/).filter(Boolean) : [];
}
