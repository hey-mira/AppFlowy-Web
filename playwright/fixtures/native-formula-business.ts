import Decimal from 'big.js';

import { FieldType } from '@/application/database-yjs/database.type';
import { CellSpec, FieldSpec, selectOptions } from '@/application/database-yjs/fields/formula/__tests__/fixture';

import dataset from './researched-scenarios.json';

type Input = null | string | number | boolean | string[];
type Expected = string | number | null;

export interface BusinessRow {
  id: string;
  cells: Record<string, CellSpec>;
  expected: Record<string, Expected>;
}

export interface BusinessScenario {
  id: string;
  fields: FieldSpec[];
  rows: BusinessRow[];
  caseCount: number;
}

const field = (id: string, type: FieldType): FieldSpec => ({ id, name: id, type });
const formula = (id: string, expression: string): FieldSpec => ({
  ...field(id, FieldType.Formula),
  typeOption: { expression },
});
const numeric = (cells: Record<string, CellSpec>, id: string, value: Input) => {
  if (value !== null) cells[id] = { type: FieldType.Number, data: String(value) };
};

function products(id: string, dimensions: string[]): { values: Input[][]; count: number } {
  const scenario = dataset.scenarios.find((entry) => entry.id === id) as unknown as {
    inputs: Record<string, Input[]>;
    case_count: number;
  };

  return {
    values: dimensions.reduce<Input[][]>(
      (rows, key) => rows.flatMap((row) => scenario.inputs[key].map((value) => [...row, value])),
      [[]]
    ),
    count: scenario.case_count,
  };
}

// Keep the pre-migration authored input products and independent decimal/date
// oracles, without using either evaluator to compute expected results.
export function businessScenarios(): BusinessScenario[] {
  const deadlines = products('project-deadlines', ['start', 'status']);
  const rice = products('rice-prioritization', ['reach', 'impact', 'confidence', 'effort', 'voters']);
  const invoices = products('order-invoice', ['price', 'quantity', 'discount', 'tax', 'cancelled', 'paid']);

  return [
    {
      id: 'project-deadlines',
      caseCount: deadlines.count,
      fields: [
        field('Start', FieldType.DateTime),
        {
          ...field('Status', FieldType.SingleSelect),
          typeOption: { content: selectOptions(['To do', 'In progress', 'Done'].map((value) => [value, value])) },
        },
        formula('Due', 'if(empty(prop("Start")), empty(), dateAdd(prop("Start"), 2, "weeks"))'),
        formula('Due text', 'if(empty(prop("Due")), "", formatDate(prop("Due"), "YYYY-MM-DD"))'),
        formula(
          'Outcome',
          'if(empty(prop("Due")), "Unscheduled", if(prop("Status") == "Done", "Complete", if(prop("Due") < now(), "Overdue", "On track")))'
        ),
      ],
      rows: deadlines.values.map(([start, status], index) => {
        const cells: Record<string, CellSpec> = {};
        const due = start === null ? undefined : Date.parse(`${String(start)}T00:00:00Z`) + 14 * 86400000;

        if (start !== null) {
          cells.Start = {
            type: FieldType.DateTime,
            data: String(Date.parse(`${String(start)}T00:00:00Z`) / 1000),
            extra: { include_time: false },
          };
        }

        if (status !== null) cells.Status = { type: FieldType.SingleSelect, data: String(status) };
        const legacy =
          due === undefined
            ? 'Unscheduled'
            : status === 'Done'
            ? 'Complete'
            : due < Date.parse(dataset.now_utc)
            ? 'Overdue'
            : 'On track';

        return {
          id: `deadline-${index}`,
          cells,
          expected: { 'Due text': due === undefined ? '' : new Date(due).toISOString().slice(0, 10), Outcome: legacy },
        };
      }),
    },
    {
      id: 'rice-prioritization',
      caseCount: rice.count,
      fields: [
        ...['Reach', 'Impact', 'Confidence', 'Effort'].map((id) => field(id, FieldType.Number)),
        field('Voters', FieldType.Person),
        formula(
          'Score',
          'if(empty(prop("Reach")) or empty(prop("Impact")) or empty(prop("Confidence")) or empty(prop("Effort")), 0, prop("Reach") * prop("Impact") * prop("Confidence") / prop("Effort"))'
        ),
        formula('Score copy', 'prop("Score")'),
        formula('Votes', 'length(prop("Voters"))'),
      ],
      rows: rice.values.map((values, index) => {
        const cells: Record<string, CellSpec> = {};

        ['Reach', 'Impact', 'Confidence', 'Effort'].forEach((id, position) => numeric(cells, id, values[position]));
        const voters = values[4] as string[];
        const ids = voters.map((name) =>
          name === 'Ada Lovelace' ? '10000000-0000-4000-8000-000000000001' : '10000000-0000-4000-8000-000000000002'
        );

        cells.Voters = { type: FieldType.Person, data: JSON.stringify(ids) };
        const numbers = values.slice(0, 4).map((value) => new Decimal(Number(value ?? 0)));
        const expected = numbers.some((value) => value.eq(0))
          ? 0
          : numbers[0].times(numbers[1]).times(numbers[2]).div(numbers[3]).toNumber();

        return {
          id: `rice-${index}`,
          cells,
          expected: { Score: expected, 'Score copy': expected, Votes: voters.length },
        };
      }),
    },
    {
      id: 'order-invoice',
      caseCount: invoices.count,
      fields: [
        ...['Price', 'Quantity', 'Discount', 'Tax'].map((id) => field(id, FieldType.Number)),
        field('Cancelled', FieldType.Checkbox),
        field('Paid', FieldType.Checkbox),
        formula(
          'Total',
          'if(prop("Cancelled") or empty(prop("Price")) or empty(prop("Quantity")), 0, round(prop("Price") * prop("Quantity") * (1 - prop("Discount")) * (1 + prop("Tax")) * 100) / 100)'
        ),
        formula('Outstanding', 'if(prop("Paid"), 0, prop("Total"))'),
      ],
      rows: invoices.values.map((values, index) => {
        const cells: Record<string, CellSpec> = {};

        ['Price', 'Quantity', 'Discount', 'Tax'].forEach((id, position) => numeric(cells, id, values[position]));
        cells.Cancelled = { type: FieldType.Checkbox, data: values[4] ? 'Yes' : 'No' };
        cells.Paid = { type: FieldType.Checkbox, data: values[5] ? 'Yes' : 'No' };
        const numbers = values.slice(0, 4).map((value) => new Decimal(Number(value ?? 0)));
        const cents = numbers[0]
          .times(numbers[1])
          .times(new Decimal(1).minus(numbers[2]))
          .times(new Decimal(1).plus(numbers[3]))
          .times(100);
        const whole = cents.round(0, Decimal.roundDown);
        const fraction = cents.minus(whole);
        const rounded = fraction.gte('0.5') ? whole.plus(1) : fraction.lt('-0.5') ? whole.minus(1) : whole;
        const expected = values[4] || numbers[0].eq(0) || numbers[1].eq(0) ? 0 : rounded.div(100).toNumber();

        return { id: `invoice-${index}`, cells, expected: { Total: expected, Outstanding: values[5] ? 0 : expected } };
      }),
    },
  ];
}

export const businessNow = dataset.now_utc;
