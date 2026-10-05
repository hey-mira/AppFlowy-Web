import { parseYDatabaseCellToCell } from '@/application/database-yjs/cell.parse';
import { DateTimeCell, FormulaCell } from '@/application/database-yjs/cell.type';
import { FieldType } from '@/application/database-yjs/database.type';
import {
  formulaTypeOfField,
  readFieldFormulaValue,
  ReadFieldValueContext,
} from '@/application/database-yjs/fields/formula/cell-values';
import { formatFormulaValue, FormulaFormatOptions } from '@/application/database-yjs/fields/formula/format';
import { FormulaCellResult } from '@/application/database-yjs/fields/formula/formula.type';
import {
  parseFormulaTypeOption,
  parseFormulaVisualizationOption,
} from '@/application/database-yjs/fields/formula/parse';
import { FormulaFieldSchema } from '@/application/database-yjs/fields/formula/schema';
import { EMPTY, FormulaType, FormulaValue } from '@/application/database-yjs/fields/formula/values';
import { YDatabaseField, YDatabaseRow, YjsDatabaseKey as K } from '@/application/types';

import type {
  Column,
  FormulaOutput,
  PropertyDefinition,
  PropertyState,
  RowError,
  RuntimeError,
  Value,
  ValueType,
} from '@notion-formula/sdk';

export type NativeFormulaOutcome =
  | { status: 'pending'; resultType: FormulaType }
  | { status: 'null'; resultType: FormulaType }
  | { status: 'value'; resultType: FormulaType; value: Value }
  | { status: 'not-ready'; resultType: 'any'; error: string }
  | {
      status: 'error';
      resultType: FormulaType;
      error: string;
      source?: 'host' | 'host-cycle' | 'runtime' | 'worker';
      originFormulaId?: string;
      runtimeError?: RuntimeError;
      nativeErrors?: readonly RowError[];
    };

const fieldStates = new WeakMap<YDatabaseField, PropertyState>();

/** Static metadata is shared by mounted runtimes and computed host sessions. */
export function getNativeFormulaPropertyState(field: YDatabaseField): PropertyState | undefined {
  return fieldStates.get(field);
}

export function rememberNativeFormulaPropertyState(field: YDatabaseField, state?: PropertyState | null) {
  if (state) fieldStates.set(field, state);
  else fieldStates.delete(field);
}

export function nativeValueType(type: FormulaType): ValueType {
  if (typeof type === 'object') return { List: nativeValueType(type.list) };
  switch (type) {
    case 'number':
      return 'Number';
    case 'text':
      return 'String';
    case 'boolean':
      return 'Boolean';
    case 'date':
      return 'Date';
    default:
      return 'Unknown';
  }
}

/** Union and Unknown remain conservative in AppFlowy's predicate vocabulary. */
export function appFlowyFormulaType(type: ValueType): FormulaType {
  if (typeof type === 'object') return 'List' in type ? { list: appFlowyFormulaType(type.List) } : 'any';
  switch (type) {
    case 'Number':
      return 'number';
    case 'String':
      return 'text';
    case 'Boolean':
      return 'boolean';
    case 'Date':
      return 'date';
    default:
      return 'any';
  }
}

export function nativePropertyDefinition(entry: FormulaFieldSchema): PropertyDefinition {
  return entry.type === FieldType.Formula
    ? { Formula: { id: entry.id, expression: parseFormulaTypeOption(entry.field).formula } }
    : { Input: { id: entry.id, ty: nativeValueType(formulaTypeOfField(entry)) } };
}

export function nativePropertyType(state?: PropertyState): FormulaType {
  if (!state || 'Input' in state || state.Formula.status === 'NotReady') return 'any';
  return appFlowyFormulaType(state.Formula.status.Ready.output_type);
}

/** Convert the host's seconds to milliseconds without a floating-point round trip. */
function timestampMilliseconds(raw: unknown): bigint | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(String(raw));

  if (!match) throw new Error('Invalid date input');
  const sign = match[1] === '-' ? BigInt(-1) : BigInt(1);
  const integer = BigInt(match[2]);

  if (integer > BigInt('1000000000000')) return sign * integer;
  return sign * (integer * BigInt(1000) + BigInt((match[3] ?? '').padEnd(3, '0').slice(0, 3)));
}

function formulaValueToNative(value: FormulaValue): Value | null {
  switch (value.type) {
    case 'empty':
      return null;
    case 'number':
      return { Number: value.value };
    case 'text':
      return { String: value.value };
    case 'boolean':
      return { Boolean: value.value };
    case 'list':
      return { List: value.items.map(formulaValueToNative) };
    case 'date':
      return {
        DateValue: {
          start: BigInt(Math.trunc(value.value.start)),
          end: value.value.end === undefined ? null : BigInt(Math.trunc(value.value.end)),
          include_time: value.value.includeTime,
        },
      };
  }
}

/** Existing host decoders keep select names, people names, media and relation titles. */
export function readNativeInput(
  entry: FormulaFieldSchema,
  row: YDatabaseRow,
  context: ReadFieldValueContext
): Value | null {
  const cell = row.get(K.cells)?.get(entry.id);

  if (entry.type === FieldType.Number) {
    const data = cell ? parseYDatabaseCellToCell(cell, entry.field).data : undefined;

    return data === undefined || data === null || data === '' ? null : { Number: Number(data) };
  }

  if (entry.type === FieldType.Rollup) {
    const value = context.getRollupValue?.(entry.id);

    if (!value) throw new Error(`Rollup ${entry.id} is not loaded`);
    if (value.error) throw new Error(value.error);
    if (formulaTypeOfField(entry) === 'number') {
      return value.rawNumeric === undefined ? null : { Number: value.rawNumeric };
    }
  }

  if (
    entry.type === FieldType.DateTime ||
    entry.type === FieldType.CreatedTime ||
    entry.type === FieldType.LastEditedTime
  ) {
    const parsed = cell ? (parseYDatabaseCellToCell(cell, entry.field) as DateTimeCell) : undefined;

    const raw =
      entry.type === FieldType.CreatedTime
        ? row.get(K.created_at)
        : entry.type === FieldType.LastEditedTime
        ? row.get(K.last_modified)
        : parsed?.data;
    const ms = timestampMilliseconds(raw);

    return ms === null
      ? null
      : {
          DateValue: {
            start: ms,
            end:
              entry.type === FieldType.DateTime && parsed?.isRange ? timestampMilliseconds(parsed.endTimestamp) : null,
            include_time: entry.type === FieldType.DateTime ? Boolean(parsed?.includeTime) : true,
          },
        };
  }

  return formulaValueToNative(readFieldFormulaValue(entry, row, context));
}

/** All registered Inputs are supplied; proven-unused inputs have typed null columns. */
export function nativeInputColumn(type: ValueType, values: Array<Value | null>): Column {
  const validity = values.map((value) => value !== null);

  switch (type) {
    case 'Number':
      return { Number: { validity, values: values.map((value) => (value && 'Number' in value ? value.Number : 0)) } };
    case 'String':
      return { String: { validity, values: values.map((value) => (value && 'String' in value ? value.String : '')) } };
    case 'Boolean':
      return {
        Boolean: { validity, values: values.map((value) => (value && 'Boolean' in value ? value.Boolean : false)) },
      };
    case 'Date':
      return {
        DateValue: {
          validity,
          values: values.map((value) =>
            value && 'DateValue' in value
              ? value.DateValue
              : { start: value && 'Date' in value ? value.Date : BigInt(0), end: null, include_time: true }
          ),
        },
      };
    default:
      return typeof type === 'object' && 'List' in type
        ? { List: { validity, values: values.map((value) => (value && 'List' in value ? value.List : [])) } }
        : { Union: { validity, values: values.map((value) => value ?? { Number: 0 }) } };
  }
}

export function nativeOutputOutcome(output: FormulaOutput, index: number): NativeFormulaOutcome {
  const resultType = appFlowyFormulaType(output.output_type);
  const rowErrors = output.errors.filter((error) => error.row_index === index);
  const rowError = rowErrors[0];

  if (rowError)
    return {
      status: 'error',
      resultType,
      error: describeNativeError(rowError.error),
      source: 'runtime',
      runtimeError: rowError.error,
      originFormulaId: rowError.origin_formula_id,
      nativeErrors: rowErrors,
    };
  const column = output.column;

  if ('Number' in column)
    return column.Number.validity[index]
      ? { status: 'value', resultType, value: { Number: column.Number.values[index] } }
      : { status: 'null', resultType };
  if ('String' in column)
    return column.String.validity[index]
      ? { status: 'value', resultType, value: { String: column.String.values[index] } }
      : { status: 'null', resultType };
  if ('Boolean' in column)
    return column.Boolean.validity[index]
      ? { status: 'value', resultType, value: { Boolean: column.Boolean.values[index] } }
      : { status: 'null', resultType };
  if ('Date' in column)
    return column.Date.validity[index]
      ? { status: 'value', resultType, value: { Date: column.Date.values[index] } }
      : { status: 'null', resultType };
  if ('DateValue' in column)
    return column.DateValue.validity[index]
      ? { status: 'value', resultType, value: { DateValue: column.DateValue.values[index] } }
      : { status: 'null', resultType };
  if ('List' in column)
    return column.List.validity[index]
      ? { status: 'value', resultType, value: { List: column.List.values[index] } }
      : { status: 'null', resultType };
  return column.Union.validity[index]
    ? { status: 'value', resultType, value: column.Union.values[index] }
    : { status: 'null', resultType };
}

function describeNativeError(error: RuntimeError): string {
  if (typeof error === 'string') return error;
  return JSON.stringify(error, (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value));
}

function nativeValueToFormula(value: Value | null): FormulaValue {
  if (value === null) return EMPTY;
  if ('Number' in value) return { type: 'number', value: value.Number };
  if ('String' in value) return { type: 'text', value: value.String };
  if ('Boolean' in value) return { type: 'boolean', value: value.Boolean };
  if ('List' in value) return { type: 'list', items: value.List.map(nativeValueToFormula) };
  const date = 'DateValue' in value ? value.DateValue : { start: value.Date, end: null, include_time: true };
  const ms = Number(date.start);
  const end = date.end === null ? undefined : Number(date.end);

  if (
    !Number.isSafeInteger(ms) ||
    Number.isNaN(new Date(ms).getTime()) ||
    (end !== undefined && (!Number.isSafeInteger(end) || Number.isNaN(new Date(end).getTime())))
  ) {
    throw new Error('Formula date is outside AppFlowy’s supported display range');
  }

  return { type: 'date', value: { start: ms, end, includeTime: date.include_time } };
}

export function projectNativeFormulaResult(
  outcome: NativeFormulaOutcome,
  field: YDatabaseField
): FormulaCellResult & Pick<FormulaCell, 'evaluationState' | 'errorSource' | 'nativeErrors' | 'nativeValue'> {
  const nativeValue = outcome.status === 'value' ? outcome.value : undefined;

  try {
    const value = nativeValue ? nativeValueToFormula(nativeValue) : EMPTY;
    const options = parseFormulaTypeOption(field);
    const result: FormulaCellResult = {
      value,
      resultType: outcome.resultType,
      text: formatNativeFormulaValue(value, { numberFormat: options.format }),
    };

    if ('error' in outcome) result.error = outcome.error;
    if (value.type === 'number') result.rawNumeric = value.value;
    if (value.type === 'boolean') result.rawBoolean = value.value;
    if (value.type === 'date')
      result.rawDate = {
        start: value.value.start / 1000,
        end: value.value.end === undefined ? undefined : value.value.end / 1000,
        includeTime: value.value.includeTime,
      };
    return {
      ...result,
      evaluationState: outcome.status,
      nativeValue,
      errorSource: outcome.status === 'error' ? outcome.source : undefined,
      nativeErrors: outcome.status === 'error' ? outcome.nativeErrors : undefined,
    };
  } catch (error) {
    return {
      value: EMPTY,
      resultType: outcome.resultType,
      text: '',
      nativeValue,
      evaluationState: 'error',
      errorSource: 'host-projection',
      error: error instanceof Error ? error.message : 'Formula value could not be displayed',
    };
  }
}

/** Non-finite native numbers remain values, including inside mixed date lists. */
export function formatNativeFormulaValue(value: FormulaValue, options: FormulaFormatOptions = {}): string {
  if (value.type === 'number' && (!Number.isFinite(value.value) || Object.is(value.value, -0)))
    return Object.is(value.value, -0) ? '-0' : String(value.value);
  if (value.type === 'list') return value.items.map((item) => formatNativeFormulaValue(item, options)).join(', ');
  return formatFormulaValue(value, options);
}

export function projectNativeFormulaCell(outcome: NativeFormulaOutcome, field: YDatabaseField): FormulaCell {
  const options = parseFormulaTypeOption(field);
  const result = projectNativeFormulaResult(outcome, field);

  return {
    createdAt: 0,
    lastModified: 0,
    fieldType: FieldType.Formula,
    data: result.text,
    ...result,
    isBlank: options.formula.trim() === '',
    numberFormat: options.format,
    visualization: parseFormulaVisualizationOption(options),
  };
}
