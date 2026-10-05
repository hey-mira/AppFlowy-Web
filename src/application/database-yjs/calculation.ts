import { CalculationType, FieldType } from '@/application/database-yjs/database.type';
import { getChecked } from '@/application/database-yjs/fields/checkbox/utils';
import { EnhancedBigStats } from '@/application/database-yjs/fields/number/EnhancedBigStats';

type CalculationInput = {
  fieldType: FieldType;
  calculationType: CalculationType;
  cellValues: Iterable<unknown>;
  preserveNativeNumbers?: boolean;
};

/** These saved operations require Number values regardless of a formula's static type. */
export function isNumericCalculation(type: CalculationType): boolean {
  return [
    CalculationType.Sum,
    CalculationType.Average,
    CalculationType.Median,
    CalculationType.Min,
    CalculationType.Max,
    CalculationType.NumberRange,
    CalculationType.NumberMode,
  ].includes(type);
}

function countBy<T>(values: T[], iteratee: (value: T) => string | number): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    const key = String(iteratee(value));

    result[key] = (result[key] ?? 0) + 1;

    return result;
  }, {});
}

export function calculateFieldValue({
  fieldType,
  calculationType,
  cellValues,
  preserveNativeNumbers = false,
}: CalculationInput): string | number | null {
  const values = Array.from(cellValues);

  const countEmptyResult = countBy(values, (data) => {
    if (preserveNativeNumbers && typeof data === 'number') return CalculationType.CountNonEmpty;
    if (fieldType === FieldType.Checkbox) {
      return getChecked(data as string | number | boolean) ? CalculationType.CountNonEmpty : CalculationType.CountEmpty;
    }

    if (fieldType === FieldType.Checklist && typeof data === 'string') {
      try {
        const { options, selected_option_ids } = JSON.parse(data);
        const percentage = selected_option_ids.length / options.length;

        if (percentage === 1) {
          return CalculationType.CountNonEmpty;
        }

        return CalculationType.CountEmpty;
      } catch (e) {
        // fall through to treat the value as non-empty/empty
      }
    }

    if (!data && data !== 0) {
      return CalculationType.CountEmpty;
    }

    return CalculationType.CountNonEmpty;
  });

  // Decimal statistics cannot represent native IEEE-754 values. Keep them
  // valid and preserve signed zero without changing ordinary Number columns.
  const nativeNumbers = values.filter((value): value is number => typeof value === 'number');

  if (preserveNativeNumbers && nativeNumbers.some((value) => !Number.isFinite(value) || Object.is(value, -0))) {
    let result: number | undefined;

    switch (calculationType) {
      case CalculationType.Sum:
        result = nativeNumbers.reduce((sum, value) => sum + value);
        break;
      case CalculationType.Average:
        result = nativeNumbers.reduce((sum, value) => sum + value) / nativeNumbers.length;
        break;
      case CalculationType.Min:
        result = nativeNumbers.reduce((minimum, value) => Math.min(minimum, value));
        break;
      case CalculationType.Max:
        result = nativeNumbers.reduce((maximum, value) => Math.max(maximum, value));
        break;
      case CalculationType.Median: {
        const sorted = [...nativeNumbers].sort((a, b) => a - b);
        const middle = Math.floor(sorted.length / 2);

        result = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
        break;
      }
    }

    if (result !== undefined) return Object.is(result, -0) ? '-0' : String(result);
  }

  const itemMap = (data: unknown) => {
    if (typeof data === 'number') {
      return data.toString();
    }

    if (typeof data === 'string') {
      return EnhancedBigStats.parse(data);
    }

    return null;
  };

  const nums = values
    .map(itemMap)
    .filter((item) => !!item && (!preserveNativeNumbers || Number.isFinite(Number(item)))) as string[];
  const stats = new EnhancedBigStats(nums);

  switch (calculationType) {
    case CalculationType.CountEmpty:
      return countEmptyResult[CalculationType.CountEmpty] ?? 0;
    case CalculationType.CountNonEmpty:
      return countEmptyResult[CalculationType.CountNonEmpty] ?? 0;
    case CalculationType.Count:
      return values.length;
    case CalculationType.Sum:
      return stats.sum().toString();
    case CalculationType.Average:
      return stats.average().toString();
    case CalculationType.Median:
      return stats.median().toString();
    case CalculationType.Max:
      return stats.max().toString();
    case CalculationType.Min:
      return stats.min().toString();
    default:
      return null;
  }
}
