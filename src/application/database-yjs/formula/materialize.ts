import { RelatedRowLoaders } from '@/application/database-yjs/formula/read-context';
import { readRelationMembership } from '@/application/database-yjs/relation/cache';
import { retainRollupSource, RollupSourceSync } from '@/application/database-yjs/rollup/source-sync';
import { YDoc } from '@/application/types';

/** A permanent conversion must not mistake unhydrated row orders for live membership. */
export function waitForRelationMembership(doc: YDoc): Promise<ReadonlySet<string>> {
  const existing = readRelationMembership(doc);

  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      doc.off('update', changed);
      clearTimeout(timer);
    };

    const changed = () => {
      const ids = readRelationMembership(doc);

      if (!ids) return;
      cleanup();
      resolve(ids);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Related database row membership could not be loaded for formula conversion'));
    }, 3000);

    doc.on('update', changed);
  });
}

/** Watch related rows and schemas before their values are read, for one conversion pass. */
export function observeFormulaRelatedDocuments(
  loaders: RelatedRowLoaders & RollupSourceSync,
  changed: () => void,
  signal?: AbortSignal
) {
  const { loadView, createRow } = loaders;
  const documents = new Set<YDoc>();
  const metadataDocuments = new WeakSet<YDoc>();
  const releases = new Map<YDoc, () => void>();
  let active = true;
  const observe = <T extends YDoc | null>(doc: T): T => {
    if (active && !signal?.aborted && doc && !documents.has(doc)) {
      documents.add(doc);
      doc.on('update', changed);
    }

    if (active && !signal?.aborted && doc && metadataDocuments.has(doc) && !releases.has(doc)) {
      const release = retainRollupSource(loaders, doc);

      if (active) releases.set(doc, release);
      else release();
    }

    return doc;
  };

  const requireActivePass = () => {
    if (signal?.aborted) throw new DOMException('Formula conversion cancelled', 'AbortError');
  };

  return {
    observe,
    loaders: {
      ...loaders,
      loadView: loadView ? async (...args) => {
        requireActivePass();
        const doc = await loadView(...args);

        requireActivePass();
        if (doc) metadataDocuments.add(doc);
        return observe(doc);
      } : undefined,
      createRow: createRow ? async (...args) => {
        requireActivePass();
        const doc = await createRow(...args);

        requireActivePass();
        return observe(doc);
      } : undefined,
    } satisfies RelatedRowLoaders,
    dispose: () => {
      // A sibling read may still settle after another read fails. It must not
      // attach observers after this pass has already been released.
      active = false;
      documents.forEach((doc) => doc.off('update', changed));
      documents.clear();
      releases.forEach((release) => release());
      releases.clear();
    },
  };
}
