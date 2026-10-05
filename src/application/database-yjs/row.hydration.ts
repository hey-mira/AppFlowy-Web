import { YDoc, YjsEditorKey } from '@/application/types';

const ROW_HYDRATION_TIMEOUT_MS = 3000;

function hasDatabaseRow(rowDoc: YDoc): boolean {
  return rowDoc.getMap(YjsEditorKey.data_section).has(YjsEditorKey.database_row);
}

/** Wait until an opened row collab contains its database_row payload. */
export function waitForDatabaseRowHydration(
  rowDoc: YDoc,
  timeoutMs = ROW_HYDRATION_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<YDoc | null> {
  if (signal?.aborted) return Promise.reject(new DOMException('Row hydration cancelled', 'AbortError'));
  if (hasDatabaseRow(rowDoc)) return Promise.resolve(rowDoc);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: YDoc | null, aborted = false) => {
      if (settled) return;
      settled = true;
      rowDoc.off('update', listener);
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (aborted) reject(new DOMException('Row hydration cancelled', 'AbortError'));
      else resolve(value);
    };

    const listener = () => {
      if (hasDatabaseRow(rowDoc)) finish(rowDoc);
    };

    const onAbort = () => finish(null, true);

    const timer = setTimeout(() => finish(null), timeoutMs);

    rowDoc.on('update', listener);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
