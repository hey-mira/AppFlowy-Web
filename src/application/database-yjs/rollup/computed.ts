import type { NativeFormulaEngineLease } from '@/application/database-yjs/formula/native-engine';
import { YDoc, YjsDatabaseKey as K } from '@/application/types';

import type { RollupCellValue, RollupComputeContext } from './cache';

export class ComputedDependencyError extends Error {}

/** One evaluation path crosses database boundaries without sharing an in-flight cache promise. */
export interface ComputedSession {
  signal?: AbortSignal;
  path: ReadonlySet<string>;
  rollupDepth?: number;
  now: number;
  /** All native formula evaluations on one path share database Workers. */
  nativeFormulaEngines?: Map<YDoc, NativeFormulaEngineLease>;
  observe?: (doc: YDoc) => void;
  usesClock?: () => void;
  usesPeople?: () => void;
}

export function enterComputedCell(
  context: RollupComputeContext,
  session: ComputedSession,
  formula = false
): ComputedSession {
  if (session.signal?.aborted) throw new DOMException('Rollup observation cancelled', 'AbortError');
  const key = JSON.stringify([context.database.get(K.id) ?? context.baseDoc.guid, context.rowId, context.fieldId]);

  if (session.path.has(key)) throw new ComputedDependencyError('Circular formula and rollup dependency');
  // Match Desktop: the limit counts rollup hops, independently of intervening Formula nodes.
  const rollupDepth = session.rollupDepth ?? 0;

  if (!formula && rollupDepth >= 64) throw new ComputedDependencyError('Formula and rollup dependencies are too deep');
  const path = new Set(session.path);

  path.add(key);
  session.observe?.(context.baseDoc);
  if (context.row.doc) session.observe?.(context.row.doc as YDoc);
  return { ...session, path, rollupDepth: rollupDepth + (formula ? 0 : 1) };
}

/** Release the Workers retained by a completed outer computed session. */
export function releaseComputedFormulaEngines(session: ComputedSession) {
  session.nativeFormulaEngines?.forEach((lease) => lease.release());
  session.nativeFormulaEngines?.clear();
}

/** Resolve host inputs, then evaluate the formula through its database's native Engine. */
export async function evaluateRollupFormula(
  context: RollupComputeContext,
  session: ComputedSession,
  computeRollup: (context: RollupComputeContext, session: ComputedSession) => Promise<RollupCellValue>
) {
  const current = enterComputedCell(context, session, true);
  const { evaluateNativeFormulaInSession } = await import('../formula/native-session');

  return evaluateNativeFormulaInSession(context, current, computeRollup);
}
