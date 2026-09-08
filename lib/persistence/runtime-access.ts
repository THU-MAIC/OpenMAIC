import { isServerOnlyRuntimeKind } from '@/lib/zhongkao/runtime-kinds';
import { isPlainRecord } from '@/lib/zhongkao/validation';

function isTeacherProfileStage(stageId: unknown): boolean {
  if (typeof stageId !== 'string' || !stageId.startsWith('zhongkao-profile:')) return false;
  try {
    return decodeURIComponent(stageId.slice('zhongkao-profile:'.length)).startsWith(
      'teacher-student:v1:',
    );
  } catch {
    return false;
  }
}

/** Teacher profiles share the original profile kind but can only be edited via teacher APIs. */
export function isServerOnlyRuntimeSession(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  if (isServerOnlyRuntimeKind(value.kind) || isTeacherProfileStage(value.stageId)) return true;
  if (typeof value.id !== 'string' || !value.id.startsWith('zhongkao:zhongkaoStudentProfile:')) {
    return false;
  }
  try {
    return isTeacherProfileStage(decodeURIComponent(value.id.split(':')[2]));
  } catch {
    return false;
  }
}
