import { DateTimeCell } from '@/application/database-yjs/cell.type';
import { FieldType } from '@/application/database-yjs/database.type';
import {
  FormulaCellResult,
  FormulaType,
} from '@/application/database-yjs/fields/formula';
import { getNativeFormulaPropertyState } from '@/application/database-yjs/formula/native-runtime';
import { nativePropertyType } from '@/application/database-yjs/formula/native-values';
import { YDatabaseField, YDatabaseFields } from '@/application/types';

/** Static result type of a formula field (`any` when the expression is invalid). */
export function formulaResultTypeOfField(field: YDatabaseField, fields?: YDatabaseFields): FormulaType {
  void fields;
  return nativePropertyType(getNativeFormulaPropertyState(field));
}

/**
 * The native field type whose filter and sort vocabulary a formula borrows:
 * numbers filter like Number, booleans like Checkbox, dates like Date, and
 * everything else (text, lists, invalid) like Text.
 */
export function formulaPredicateFieldType(field: YDatabaseField, fields?: YDatabaseFields): FieldType {
  return predicateFieldTypeForResult(formulaResultTypeOfField(field, fields));
}

export function predicateFieldTypeForResult(resultType: FormulaType): FieldType {
  switch (resultType) {
    case 'number':
      return FieldType.Number;
    case 'boolean':
      return FieldType.Checkbox;
    case 'date':
      return FieldType.DateTime;
    default:
      return FieldType.RichText;
  }
}

/** A date result shaped like a Date cell so the date filter predicates apply unchanged. */
export function formulaResultToDateCell(result: FormulaCellResult): DateTimeCell | null {
  if (!result.rawDate) return null;

  return {
    fieldType: FieldType.DateTime,
    createdAt: 0,
    lastModified: 0,
    data: String(result.rawDate.start),
    // Desktop date predicates use a single date as both endpoints. Keep this
    // fallback at the formula boundary; rollup lists preserve missing ends.
    endTimestamp: String(result.rawDate.end ?? result.rawDate.start),
    isRange: result.rawDate.end !== undefined,
    includeTime: result.rawDate.includeTime,
  };
}

/** The text a number-typed formula exposes to number predicates (plain, unformatted). */
export function formulaResultToNumberText(result: FormulaCellResult): string {
  return result.rawNumeric === undefined ? '' : String(result.rawNumeric);
}
