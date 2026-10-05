import { useCallback } from 'react';

import { getCell, useFieldSelector } from '@/application/database-yjs';
import { parseYDatabaseCellToCell } from '@/application/database-yjs/cell.parse';
import { useNativeFormulaColumnValues } from '@/application/database-yjs/formula/native-column';
import { useTimelineRowSource } from '@/application/database-yjs/hooks/TimelineRowValuesProvider';
import { useTimelineRowValuesSnapshot } from '@/application/database-yjs/hooks/useTimelineRowValues';
import { YDoc } from '@/application/types';
import { GridCalculateRowCellWithValues } from '@/components/database/components/grid/grid-cell/GridCalculateRowCell';

/** Calculations use the same detached/live row source as the timeline bars. */
export function TimelineCalculation({ fieldId }: { fieldId: string }) {
  const { field, clock } = useFieldSelector(fieldId);
  const rowSource = useTimelineRowSource();
  // A formula column has no stored cell; calculate over its results.
  const formula = useNativeFormulaColumnValues(fieldId, rowSource);
  const parse = useCallback(
    (rowId: string, doc: YDoc) => {
      // Type options can change without replacing the Y.Map field object.
      void clock;
      if (!field) return undefined;
      if (formula) return formula.cells?.get(rowId);

      const cell = getCell(rowId, fieldId, { [rowId]: doc });

      return cell ? parseYDatabaseCellToCell(cell, field).data : '';
    },
    [clock, field, fieldId, formula]
  );
  const { values, complete } = useTimelineRowValuesSnapshot(parse);

  return (
    <GridCalculateRowCellWithValues
      fieldId={fieldId}
      cells={formula ? formula.cells : values}
      ready={complete && Boolean(field) && (!formula || formula.status === 'ready')}
      evaluationState={formula?.status}
      formulaResults={formula?.results}
      error={formula?.error}
    />
  );
}
