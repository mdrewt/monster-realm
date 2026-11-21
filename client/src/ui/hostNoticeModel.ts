// ui/hostNoticeModel — skeleton: contracts only, no behaviour yet.
import type { StorageLike } from '../input/bindingStore';
import type { TargetKind } from '../net/shellDocument';

export function hostNoticeStorageKey(_uri: string, _db: string): string {
  return '';
}

export function hostNoticeDue(
  _kind: TargetKind,
  _storage: StorageLike | null,
  _uri: string,
  _db: string,
): boolean {
  return false;
}

export function markHostNoticeSeen(_storage: StorageLike | null, _uri: string, _db: string): boolean {
  return false;
}
