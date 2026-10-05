import { YDoc } from '@/application/types';

import type { FormulaEngineClient, FormulaSchema, PropertyDefinition } from '@notion-formula/sdk';

export interface NativeFormulaEngineLease {
  synchronize: (schema: FormulaSchema) => Promise<FormulaEngineClient>;
  release: () => void;
}

type EngineHost = {
  users: number;
  closing: boolean;
  client?: FormulaEngineClient;
  definitions: Map<string, string>;
  tail: Promise<void>;
  release: () => void;
};

const engines = new WeakMap<YDoc, Map<string, EngineHost>>();
const propertyId = (property: PropertyDefinition) => ('Input' in property ? property.Input.id : property.Formula.id);

/** Leases share a database Worker across display batches and nested rollup sessions. */
export function retainNativeFormulaEngine(doc: YDoc, contextKey = 'live'): NativeFormulaEngineLease {
  let contexts = engines.get(doc);

  if (!contexts) {
    contexts = new Map();
    engines.set(doc, contexts);
  }

  let host = contexts.get(contextKey);

  if (!host || host.closing) {
    const current: EngineHost = {
      users: 0,
      closing: false,
      definitions: new Map(),
      tail: Promise.resolve(),
      release: () => undefined,
    };
    const close = () => {
      if (current.closing) return;
      current.closing = true;
      if (contexts?.get(contextKey) === current) contexts.delete(contextKey);
      doc.off('destroy', close);
      void current.tail.then(() => current.client?.close()).catch(() => undefined);
    };

    current.release = () => {
      current.users -= 1;
      // React can replace several consumers during one commit. Keep their
      // shared Engine alive when another owner retains it in that same turn.
      queueMicrotask(() => {
        if (current.users === 0) close();
      });
    };

    contexts.set(contextKey, current);
    doc.on('destroy', close);
    host = current;
  }

  const current = host;

  current.users += 1;
  let released = false;

  return {
    synchronize: (schema) => {
      const synchronize = async () => {
        if (released || current.closing) throw new Error('Formula database session is closed');
        if (!current.client) {
          const { createFormulaEngineClient } = await import('@notion-formula/sdk');

          current.client = await createFormulaEngineClient(schema);
          current.definitions = new Map(
            schema.properties.map((property) => [propertyId(property), JSON.stringify(property)])
          );
        } else {
          const next = new Map(schema.properties.map((property) => [propertyId(property), JSON.stringify(property)]));

          for (const id of current.definitions.keys()) {
            if (!next.has(id)) {
              await current.client.remove(id);
              current.definitions.delete(id);
            }
          }

          for (const property of schema.properties) {
            const id = propertyId(property);
            const signature = next.get(id)!;

            if (current.definitions.get(id) !== signature) {
              await current.client.upsert(property);
              current.definitions.set(id, signature);
            }
          }
        }

        return current.client;
      };

      const result = current.tail.then(synchronize);

      current.tail = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
    release: () => {
      if (released) return;
      released = true;
      current.release();
    },
  };
}
