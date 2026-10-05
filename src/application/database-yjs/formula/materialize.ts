import { RelatedRowLoaders } from '@/application/database-yjs/formula/read-context';
import { readRelationMembership } from '@/application/database-yjs/relation/cache';
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
export function observeFormulaRelatedDocuments(loaders: RelatedRowLoaders, changed: () => void) {
  const { loadView, createRow } = loaders;
  const documents = new Set<YDoc>();
  let active = true;
  const observe = <T extends YDoc | null>(doc: T): T => {
    if (active && doc && !documents.has(doc)) {
      documents.add(doc);
      doc.on('update', changed);
    }

    return doc;
  };

  return {
    observe,
    loaders: {
      ...loaders,
      loadView: loadView ? async (...args) => observe(await loadView(...args)) : undefined,
      createRow: createRow ? async (...args) => observe(await createRow(...args)) : undefined,
    } satisfies RelatedRowLoaders,
    dispose: () => {
      // A sibling read may still settle after another read fails. It must not
      // attach observers after this pass has already been released.
      active = false;
      documents.forEach((doc) => doc.off('update', changed));
      documents.clear();
    },
  };
}
