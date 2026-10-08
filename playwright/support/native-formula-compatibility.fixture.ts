import { createFormulaEngineClient } from '@notion-formula/sdk';

import { FieldType } from '@/application/database-yjs/database.type';
import { createFields, createRow } from '@/application/database-yjs/fields/formula/__tests__/fixture';
import { readFormulaSchema } from '@/application/database-yjs/fields/formula/schema';
import {
  nativeInputColumn,
  nativePropertyDefinition,
  readNativeInput,
} from '@/application/database-yjs/formula/native-values';
import { FORMULA_FUNCTION_DOCS } from '@/components/database/components/property/formula/formula-docs';
import { findPropReferences } from '@/components/database/components/property/formula/property-references';

import { businessNow, businessScenarios, BusinessRow } from '../fixtures/native-formula-business';
import { workflowDefinitions, workflowInputs, workflowRows } from '../fixtures/native-formula-workflows';

import type { Column, FormulaDraftState, FormulaOutput, ValueType } from '@notion-formula/sdk';

export interface CompatibilityExample {
  name: string;
  expression: string;
  expected: string;
  status: 'requires-properties' | 'invalid' | 'runtime-error' | 'ready';
  diagnostics: string[];
  outputType: ValueType;
  column?: Column;
  errors?: unknown;
}

export interface CompatibilityReport {
  failure?: string;
  rowId: string;
  now: string;
  examples: CompatibilityExample[];
  workflows?: {
    rows: Array<{ id: string; formulaId: string; expected: string }>;
    formulas: Array<{ id: string; diagnostics: string[]; output?: FormulaOutput }>;
  };
  business?: Array<{
    id: string;
    caseCount: number;
    rows: Array<Pick<BusinessRow, 'id' | 'expected'>>;
    outputs: Array<{ id: string; output?: FormulaOutput }>;
  }>;
}

const rowId = 'documentation-row';
const now = '2024-03-05T10:30:00Z';

async function runBusiness(): Promise<CompatibilityReport['business']> {
  const reports: NonNullable<CompatibilityReport['business']> = [];

  for (const scenario of businessScenarios()) {
    const fields = createFields(scenario.fields);
    const schema = readFormulaSchema(fields);
    const definitions = schema.map(nativePropertyDefinition);
    const engine = await createFormulaEngineClient({ properties: definitions });

    try {
      const inputs = schema.filter((entry) => entry.type !== FieldType.Formula);
      const values = scenario.rows.map((record) => {
        const fixture = createRow(record.id, record.cells);

        try {
          return inputs.map((entry) => readNativeInput(entry, fixture.row, {}));
        } finally {
          fixture.doc.destroy();
        }
      });
      const formulaIds = schema.filter((entry) => entry.type === FieldType.Formula).map((entry) => entry.id);
      const result = await engine.evaluate({
        row_ids: scenario.rows.map((row) => row.id),
        columns: new Map(
          inputs.map((entry, index) => {
            const definition = nativePropertyDefinition(entry);

            if (!('Input' in definition)) throw new Error('Expected an Input definition');
            return [
              entry.id,
              nativeInputColumn(
                definition.Input.ty,
                values.map((row) => row[index])
              ),
            ];
          })
        ),
        formula_ids: formulaIds,
        runtime: { now: BigInt(Date.parse(businessNow)), time_zone: '+00:00' },
      });

      reports.push({
        id: scenario.id,
        caseCount: scenario.caseCount,
        rows: scenario.rows.map(({ id, expected }) => ({ id, expected })),
        outputs: formulaIds.map((id) => {
          const output = result.formulas.get(id);

          return { id, output: output && 'Ok' in output ? output.Ok : undefined };
        }),
      });
    } finally {
      await engine.close();
      fields.doc?.destroy();
    }
  }

  return reports;
}

async function runWorkflows(): Promise<CompatibilityReport['workflows']> {
  const engine = await createFormulaEngineClient({
    properties: [...workflowInputs.map((Input) => ({ Input })), ...workflowDefinitions.map((Formula) => ({ Formula }))],
  });

  try {
    const columns = new Map<string, Column>();

    for (const input of workflowInputs) {
      const values = workflowRows.map((row) => row.values[input.id] ?? null);
      const validity = values.map((value) => value !== null);

      if (input.ty === 'Boolean') {
        // An absent AppFlowy checkbox is false, unlike an absent Number/Date.
        columns.set(input.id, {
          Boolean: { values: values.map((value) => value === true), validity: values.map(() => true) },
        });
      } else if (input.ty === 'Date') {
        columns.set(input.id, {
          DateValue: {
            values: values.map((value) => ({ start: BigInt((value as number) ?? 0), end: null, include_time: false })),
            validity,
          },
        });
      } else {
        columns.set(input.id, { Number: { values: values.map((value) => (value as number) ?? 0), validity } });
      }
    }

    const diagnostics: string[][] = [];

    for (const definition of workflowDefinitions) {
      const draft = await engine.createDraft(definition);

      try {
        diagnostics.push((await draft.getState()).diagnostics.map((diagnostic) => diagnostic.message));
      } finally {
        await draft.close();
      }
    }

    const result = await engine.evaluate({
      row_ids: workflowRows.map((row) => row.id),
      columns,
      formula_ids: workflowDefinitions.map((definition) => definition.id),
      runtime: { now: BigInt(Date.parse(now)), time_zone: '+00:00' },
    });

    return {
      rows: workflowRows.map(({ id, formulaId, expected }) => ({ id, formulaId, expected })),
      formulas: workflowDefinitions.map((definition, index) => {
        const output = result.formulas.get(definition.id);

        return {
          id: definition.id,
          diagnostics: diagnostics[index],
          output: output && 'Ok' in output ? output.Ok : undefined,
        };
      }),
    };
  } finally {
    await engine.close();
  }
}

async function run(): Promise<CompatibilityReport> {
  const examples = FORMULA_FUNCTION_DOCS.flatMap((spec) =>
    spec.examples.map((example) => ({ name: spec.name, expression: example.expression, expected: example.result }))
  );
  const definitions = examples.map((example, index) => ({ id: `example-${index}`, expression: example.expression }));
  const engine = await createFormulaEngineClient({ properties: definitions.map((Formula) => ({ Formula })) });

  try {
    const states: FormulaDraftState[] = [];

    // Complete native-token prop calls decide which examples need a host database.
    for (const definition of definitions) {
      const draft = await engine.createDraft(definition);

      try {
        states.push(await draft.getState());
      } finally {
        await draft.close();
      }
    }

    const requested = definitions.filter(
      (_, index) => findPropReferences(states[index].definition.expression, states[index].tokens).length === 0
    );
    const result = await engine.evaluate({
      row_ids: [rowId],
      columns: new Map(),
      formula_ids: requested.map((definition) => definition.id),
      runtime: { now: BigInt(Date.parse(now)), time_zone: '+00:00' },
    });

    return {
      rowId,
      now,
      workflows: await runWorkflows(),
      business: await runBusiness(),
      examples: examples.map((example, index): CompatibilityExample => {
        const state = states[index];
        const base = {
          ...example,
          outputType: state.output_type,
          diagnostics: state.diagnostics.map((diagnostic) => diagnostic.message),
        };

        if (findPropReferences(state.definition.expression, state.tokens).length)
          return { ...base, status: 'requires-properties' };
        const output = result.formulas.get(definitions[index].id);

        if (!output || 'Err' in output) return { ...base, status: 'invalid' };
        return {
          ...base,
          status: output.Ok.errors.length ? 'runtime-error' : 'ready',
          column: output.Ok.column,
          errors: output.Ok.errors,
        };
      }),
    };
  } finally {
    await engine.close();
  }
}

void run()
  .catch((error): CompatibilityReport => ({ failure: String(error), rowId, now, examples: [] }))
  .then((report) => {
    (window as unknown as { nativeCompatibilityReport: CompatibilityReport }).nativeCompatibilityReport = report;
    const output = document.createElement('pre');

    output.textContent =
      report.failure ?? report.examples.map((example) => `${example.status}: ${example.expression}`).join('\n');
    document.body.appendChild(output);
  });
