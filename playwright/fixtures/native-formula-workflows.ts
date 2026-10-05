import issue from './issue-9039-formulas.json';

import type { ValueType } from '@notion-formula/sdk';

// Sources and expected strings come from the pre-migration issue-9039 tests
// at AppFlowy-Web 4fdb4f4. Keep this oracle independent of either evaluator.
const today = Date.parse('2024-03-05T00:00:00Z');
const day = (offset: number) => today + offset * 86_400_000;
const progress = ' ➜  ██░░░░░░░ 30%';

export const workflowInputs: Array<{ id: string; ty: ValueType }> = [
  { id: 'Done', ty: 'Boolean' },
  { id: 'Archives', ty: 'Boolean' },
  { id: 'Next ', ty: 'Boolean' },
  { id: 'Hold', ty: 'Boolean' },
  { id: 'Snooze Deadline', ty: 'Date' },
  { id: 'Deadline Date', ty: 'Date' },
  { id: ' Start  Date', ty: 'Date' },
  { id: 'Completed', ty: 'Number' },
  { id: 'Goal', ty: 'Number' },
];

type Inputs = Record<string, number | boolean | null>;

export interface WorkflowRow {
  id: string;
  formulaId: string;
  values: Inputs;
  expected: string;
}

const statusBase: Inputs = {
  ' Start  Date': day(-2),
  'Deadline Date': day(5),
  'Snooze Deadline': day(9),
  Completed: 3,
  Goal: 10,
};
const statusCases: Array<[string, Inputs, string]> = [
  ['done', { Done: true }, '✅Done'],
  ['archived', { Archives: true }, '🗃️ Archive '],
  ['next', { 'Next ': true }, `🔵 Next goal${progress}`],
  ['hold', { Hold: true }, `▶️ Hold ${progress}`],
  ['late-snooze', { 'Snooze Deadline': day(-4) }, ` 🔴 Late Snooze Friday${progress}`],
  ['due-today', { 'Deadline Date': today, 'Snooze Deadline': day(3) }, `⏰ In progress${progress}`],
  ['late-deadline', { 'Deadline Date': day(-1), 'Snooze Deadline': null }, ` 🔴 Late Deadline Monday${progress}`],
  ['in-progress', {}, `🟢 In progress Sunday${progress}`],
  [
    'this-week',
    { ' Start  Date': day(3), 'Deadline Date': day(10), 'Snooze Deadline': day(15) },
    `🔵 The Next Goal Friday${progress}`,
  ],
  [
    'next-week',
    { ' Start  Date': day(7), 'Deadline Date': day(10), 'Snooze Deadline': day(15) },
    `↗ The Next Goal  Tuesday${progress}`,
  ],
  [
    'next-month',
    { ' Start  Date': day(28), 'Deadline Date': day(35), 'Snooze Deadline': day(40) },
    `↗ The future${progress}`,
  ],
  ['complete', { Completed: 10 }, '🟢 In progress Sunday ➜ 100% Completed 💪'],
  ['zero', { Completed: 0 }, '🟢 In progress Sunday ➜ ░░░░░░░░░░ 00%'],
];
const monthCases: Array<[string, string]> = [
  ['2023-12-01', '📅 جمادى الأولى'],
  ['2024-01-01', '📅 جمادى الآخرة'],
  ['2024-03-03', '📅 شعبان'],
  ['2024-03-20', '📅 رمضان'],
  ['2024-04-20', '📅 شوال'],
  ['2024-07-10', '📅 محرم'],
  ['2025-06-15', '📅 ذو الحجة'],
];

export const workflowDefinitions = [
  { id: 'status', expression: issue.statusFormula },
  { id: 'hijri', expression: issue.hijriMonthFormula },
];

export const workflowRows: WorkflowRow[] = [
  ...statusCases.map(([id, changes, expected]) => ({
    id: `status-${id}`,
    formulaId: 'status',
    values: { ...statusBase, ...changes },
    expected,
  })),
  ...monthCases.map(([start, expected]) => ({
    id: `hijri-${start}`,
    formulaId: 'hijri',
    values: { ' Start  Date': Date.parse(`${start}T00:00:00Z`) },
    expected,
  })),
  { id: 'hijri-empty', formulaId: 'hijri', values: {}, expected: '' },
];
