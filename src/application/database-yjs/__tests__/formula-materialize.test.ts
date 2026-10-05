import * as Y from 'yjs';

import { observeFormulaRelatedDocuments } from '@/application/database-yjs/formula/materialize';
import { YDoc } from '@/application/types';

describe('formula materialization observers', () => {
  it('releases related document observers, including reads that finish after disposal', async () => {
    const loadedDoc = new Y.Doc() as YDoc;
    const pendingDoc = new Y.Doc() as YDoc;
    let finishLoading!: (doc: YDoc) => void;
    const pending = new Promise<YDoc>((resolve) => {
      finishLoading = resolve;
    });
    const changed = jest.fn();
    const observed = observeFormulaRelatedDocuments(
      { createRow: async (key) => (key === 'loaded' ? loadedDoc : pending) },
      changed
    );

    await observed.loaders.createRow!('loaded');
    const read = observed.loaders.createRow!('pending');

    observed.dispose();
    finishLoading(pendingDoc);
    await read;
    loadedDoc.getMap('data').set('title', 'changed');
    pendingDoc.getMap('data').set('title', 'changed');
    expect(changed).not.toHaveBeenCalled();
  });
});
