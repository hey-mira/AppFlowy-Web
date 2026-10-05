import { createFormulaEngineClient } from '@notion-formula/sdk';

import { FieldType } from '@/application/database-yjs/database.type';
import { parseRollupTypeOption } from '@/application/database-yjs/fields/rollup/parse';
import { nativePropertyDefinition } from '@/application/database-yjs/formula/native-values';

import { FormulaFieldSchema } from './schema';

/** Inspect deletion on a private native Engine; the committed Engine stays intact. */
export async function collectDependentFormulaFields(
  schema: FormulaFieldSchema[],
  fieldId: string,
  { signal }: { signal?: AbortSignal } = {}
): Promise<FormulaFieldSchema[]> {
  if (!schema.some((entry) => entry.id === fieldId)) return [];
  // Capture mutable Yjs options before crossing the Worker boundary.
  const properties = schema.map(nativePropertyDefinition);
  const rollups = new Map<string, string[]>();

  for (const entry of schema) {
    if (entry.type !== FieldType.Rollup) continue;
    const relationId = parseRollupTypeOption(entry.field)?.relation_field_id;

    if (relationId) rollups.set(relationId, [...(rollups.get(relationId) ?? []), entry.id]);
  }

  const engine = await createFormulaEngineClient({ properties });
  const close = () => {
    void engine.close().catch(() => undefined);
  };

  const cancelled = () => {
    if (signal?.aborted) throw new DOMException('Formula dependency check was cancelled', 'AbortError');
  };

  signal?.addEventListener('abort', close, { once: true });
  try {
    cancelled();
    const affected = new Set([fieldId]);
    const removals = [fieldId];
    const scheduled = new Set(removals);

    for (const id of removals) {
      cancelled();
      const mutation = await engine.remove(id);

      cancelled();
      mutation?.affected_formulas.forEach((dependentId) => affected.add(dependentId));
      // Native edges are transitive. Only host Relation→Rollup edges need
      // synthetic removals to continue that closure through computed inputs.
      for (const affectedId of affected) {
        for (const rollupId of rollups.get(affectedId) ?? []) {
          affected.add(rollupId);
          if (!scheduled.has(rollupId)) {
            scheduled.add(rollupId);
            removals.push(rollupId);
          }
        }
      }
    }

    return schema.filter((entry) => entry.id !== fieldId && entry.type === FieldType.Formula && affected.has(entry.id));
  } finally {
    signal?.removeEventListener('abort', close);
    await engine.close();
  }
}
