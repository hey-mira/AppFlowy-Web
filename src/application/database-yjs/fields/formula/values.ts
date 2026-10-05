/** AppFlowy display/field-adapter values; native Ty and Value own formula semantics. */

export type FormulaScalarType = 'text' | 'number' | 'boolean' | 'date';

/** Host UI projection of a native result type; Unknown/Union remain conservative as `any`. */
export type FormulaType = FormulaScalarType | 'empty' | 'any' | { list: FormulaType };

export interface FormulaDate {
  /** Unix milliseconds of the start (or the single instant). */
  start: number;
  /** Unix milliseconds of the end when the value is a range. */
  end?: number;
  /** Whether the time-of-day is meaningful (AppFlowy `include_time`). */
  includeTime: boolean;
}

export type FormulaValue =
  | { type: 'text'; value: string }
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'date'; value: FormulaDate }
  | { type: 'list'; items: FormulaValue[] }
  | { type: 'empty' };

export const EMPTY: FormulaValue = { type: 'empty' };

export const text = (value: string): FormulaValue => ({ type: 'text', value });
export const num = (value: number): FormulaValue => (Number.isFinite(value) ? { type: 'number', value } : EMPTY);
export const bool = (value: boolean): FormulaValue => ({ type: 'boolean', value });
export const date = (value: FormulaDate): FormulaValue => ({ type: 'date', value });
export const list = (items: FormulaValue[]): FormulaValue => ({ type: 'list', items });

export function isListType(type: FormulaType): type is { list: FormulaType } {
  return typeof type === 'object' && type !== null && 'list' in type;
}

export function listOf(type: FormulaType): FormulaType {
  return { list: type };
}

export function typeToString(type: FormulaType): string {
  if (isListType(type)) return `list<${typeToString(type.list)}>`;
  return type;
}
