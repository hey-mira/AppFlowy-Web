import { useCallback, useMemo, useSyncExternalStore } from 'react';

import { isNumericCalculation } from '@/application/database-yjs/calculation';
import { hasRowConditionData } from '@/application/database-yjs/condition-value-cache';
import { useRowMap } from '@/application/database-yjs/context';
import { CalculationType, FieldType } from '@/application/database-yjs/database.type';
import type { FormulaCellResult } from '@/application/database-yjs/fields/formula';
import type { BackgroundRowDocChange } from '@/application/database-yjs/hooks/useBackgroundRowDocLoader';
import { useFieldSelector } from '@/application/database-yjs/selector';
import { YDoc, YjsDatabaseKey } from '@/application/types';

import { nativeFormulaOutcome, useNativeFormulaRuntime } from './native-runtime';
import { projectNativeFormulaResult } from './native-values';

const emptyRows: Record<string, YDoc> = {};
const noSubscription = () => () => undefined;
const emptySnapshot = () => emptyRows;

export interface FormulaRowSources {
  rows?: Record<string, YDoc> | null;
  rowIds?: readonly string[];
  /** Timeline calculations can also evaluate detached, background-loaded rows. */
  getCachedRowDocs?: () => Record<string, YDoc>;
  subscribeToCachedRowDocChanges?: (notify: (change: BackgroundRowDocChange) => void) => () => void;
}

export interface NativeFormulaColumnValues {
  status: 'pending' | 'ready' | 'error';
  cells: Map<string, unknown> | null;
  results?: ReadonlyMap<string, FormulaCellResult>;
  error?: string;
}

/** A saved numeric calculation validates every native kind, including empty strings. */
export function nativeFormulaCalculationError(
  results: ReadonlyMap<string, FormulaCellResult> | undefined,
  calculationType: CalculationType | undefined
): string | undefined {
  if (!results || calculationType === undefined || !isNumericCalculation(calculationType)) return undefined;
  for (const [rowId, result] of results) {
    if (result.value.type !== 'empty' && result.value.type !== 'number') {
      return `${CalculationType[calculationType]} requires Number values; row ${rowId} returned ${result.value.type}`;
    }
  }

  return undefined;
}

/** A calculation consumes a complete native batch, including detached rows. */
export function useNativeFormulaColumnValues(
  fieldId: string,
  source?: FormulaRowSources
): NativeFormulaColumnValues | undefined {
  const { field, clock } = useFieldSelector(fieldId);
  const isFormula = Number(field?.get(YjsDatabaseKey.type)) === FieldType.Formula;
  const rowMap = useRowMap();
  const subscribeCached = source?.subscribeToCachedRowDocChanges;
  const subscribe = useCallback(
    (notify: () => void) => subscribeCached?.(notify) ?? noSubscription(),
    [subscribeCached]
  );
  const cached = useSyncExternalStore(subscribe, source?.getCachedRowDocs ?? emptySnapshot, emptySnapshot);
  const active = source?.rows ?? rowMap ?? emptyRows;
  const rows = useMemo(() => {
    const result = { ...cached };

    Object.entries(active).forEach(([id, doc]) => {
      if (hasRowConditionData(doc) || !result[id]) result[id] = doc;
    });
    return result;
  }, [active, cached]);
  const snapshot = useNativeFormulaRuntime({ enabled: isFormula, rows, formulaIds: [fieldId] });

  return useMemo(() => {
    if (!isFormula || !field) return undefined;
    void clock;
    const ids = source?.rowIds ?? Object.keys(rows);
    const cells = new Map<string, unknown>();
    const results = new Map<string, FormulaCellResult>();
    let pending = false;

    for (const id of ids) {
      const outcome = nativeFormulaOutcome(snapshot, id, fieldId);

      if (!hasRowConditionData(rows[id]) || outcome.status === 'pending') {
        pending = true;
        continue;
      }

      const value = projectNativeFormulaResult(outcome, field);

      if (value.error) return { status: 'error', cells: null, error: value.error };
      cells.set(id, value.rawNumeric ?? value.rawBoolean ?? value.text);
      results.set(id, value);
    }

    return pending ? { status: 'pending', cells: null } : { status: 'ready', cells, results };
  }, [isFormula, field, clock, source?.rowIds, rows, snapshot, fieldId]);
}
