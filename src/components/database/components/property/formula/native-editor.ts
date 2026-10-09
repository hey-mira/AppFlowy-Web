import { encodeFormulaString } from '@notion-formula/sdk';

import { FormulaFieldSchema } from '@/application/database-yjs/fields/formula/schema';
import { nativePropertyDefinition } from '@/application/database-yjs/formula/native-values';

import { findPropReferences } from './property-references';

import type {
  CompletionItem,
  CursorHelp,
  FormulaDefinition,
  FormulaDraftClient,
  FormulaDraftState,
  FormulaEdit,
  FormulaEngineClient,
  PropertyDefinition,
  QuickFix,
  UpdateExpressionResult,
  ValueType,
} from '@notion-formula/sdk';

export type NativeDraftState = FormulaDraftState;

/** Display the complete inferred type, including unions and unknown elements. */
export function nativeFormulaTypeLabel(type: ValueType): string {
  if (typeof type === 'string') return type === 'String' ? 'text' : type.toLowerCase();
  if ('List' in type) return `list<${nativeFormulaTypeLabel(type.List)}>`;
  return type.Union.map(nativeFormulaTypeLabel).join(' | ');
}

const sessionLeases = new WeakMap<object, { active: number; revision: number }>();

/** React effect replay reacquires the session before the cleanup microtask. */
export function retainNativeSession(session: { close: () => void }) {
  const lease = sessionLeases.get(session) ?? { active: 0, revision: 0 };

  sessionLeases.set(session, lease);
  lease.active += 1;
  lease.revision += 1;
  return () => {
    lease.active -= 1;
    const revision = ++lease.revision;

    queueMicrotask(() => {
      if (lease.active === 0 && lease.revision === revision) session.close();
    });
  };
}

export interface NativeDraftAnalysis {
  state: NativeDraftState;
  help: CursorHelp;
  fixes: QuickFix[];
  catalogue: CompletionItem[];
}

const propertyId = (property: PropertyDefinition) => ('Input' in property ? property.Input.id : property.Formula.id);

/** A private Engine; its active Draft never locks the committed database Engine. */
export class NativeFormulaEditorSession {
  private engine?: FormulaEngineClient;
  private draft?: FormulaDraftClient;
  private definitions = new Map<string, string>();
  private catalogue: CompletionItem[] = [];
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly fieldId: string) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => {
      if (this.closed) throw new Error('Formula editor session is closed');
      return operation();
    });

    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async synchronize(properties: PropertyDefinition[], expression: string) {
    const next = new Map(properties.map((property) => [propertyId(property), JSON.stringify(property)]));
    const changed =
      next.size !== this.definitions.size ||
      Array.from(next).some(([id, definition]) => this.definitions.get(id) !== definition);

    if (!this.engine) {
      const { createFormulaEngineClient } = await import('@notion-formula/sdk');

      this.engine = await createFormulaEngineClient({ properties });
    } else if (changed) {
      await this.draft?.close();
      this.draft = undefined;
      for (const id of this.definitions.keys()) if (!next.has(id)) await this.engine.remove(id);
      for (const property of properties) {
        if (this.definitions.get(propertyId(property)) !== next.get(propertyId(property)))
          await this.engine.upsert(property);
      }
    }

    if (changed) {
      this.definitions = next;
      const catalogueDraft = await this.engine.createDraft({ id: this.fieldId, expression: '' });

      try {
        this.catalogue = (await catalogueDraft.help(0, { preferred_limit: 0 })).completion.items;
      } finally {
        await catalogueDraft.close();
      }
    }

    if (!this.draft) this.draft = await this.engine.createDraft({ id: this.fieldId, expression });
    const state = await this.draft.getState();

    return state.definition.expression === expression
      ? state
      : (await this.draft.updateExpression({ Replace: expression })).state;
  }

  analyze(properties: PropertyDefinition[], expression: string, cursor: number): Promise<NativeDraftAnalysis> {
    return this.enqueue(async () => {
      const state = await this.synchronize(properties, expression);
      const help = await this.draft!.help(cursor, { preferred_limit: 8 });
      const fixes = (
        await Promise.all(state.diagnostics.map((diagnostic) => this.draft!.quickFixes(diagnostic.id)))
      ).flat();

      return { state, help, fixes, catalogue: this.catalogue };
    });
  }

  state(properties: PropertyDefinition[], expression: string) {
    return this.enqueue(() => this.synchronize(properties, expression));
  }

  apply(edit: FormulaEdit, cursor: number): Promise<UpdateExpressionResult> {
    return this.enqueue(() => this.draft!.updateExpression({ Edits: { edit, cursor } }));
  }

  format(): Promise<FormulaEdit> {
    return this.enqueue(() => this.draft!.formatEdits());
  }

  /** Consumes the freshly validated Draft; only the host writes Yjs. */
  definition(properties: PropertyDefinition[], expression: string): Promise<FormulaDefinition | null> {
    return this.enqueue(async () => {
      const state = await this.synchronize(properties, expression);

      if (state.diagnostics.length > 0) return null;
      const definition = await this.draft!.intoDefinition();

      this.draft = undefined;
      return definition;
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    void this.tail.then(() => this.engine?.close()).catch(() => undefined);
  }
}

export function nativeEditorProperties(schema: FormulaFieldSchema[]): PropertyDefinition[] {
  return schema.map(nativePropertyDefinition);
}

/** Bind only the quoted String token of a complete native-token prop call. */
export function bindNativePropertyNames(state: NativeDraftState, schema: FormulaFieldSchema[], boundIds: Set<string>) {
  const edits: FormulaEdit['edits'] = [];
  const ambiguous: string[] = [];

  for (const reference of findPropReferences(state.definition.expression, state.tokens)) {
    if (boundIds.has(reference.ref) || schema.some((entry) => entry.id === reference.ref)) continue;
    const matches = schema.filter((entry) => entry.name === reference.ref);

    if (matches.length === 1) {
      edits.push({ range: reference.idSpan, new_text: encodeFormulaString(matches[0].id) });
      boundIds.add(matches[0].id);
    } else if (matches.length > 1)
      ambiguous.push(`Property name "${reference.ref}" is ambiguous. Choose a property from the list.`);
  }

  return { edit: { base_version: state.version, edits }, ambiguous };
}

export function displayNativePropertyNames(state: NativeDraftState, schema: FormulaFieldSchema[]) {
  let source = state.definition.expression;

  findPropReferences(state.definition.expression, state.tokens)
    .reverse()
    .forEach((reference) => {
      const entry = schema.find((entry) => entry.id === reference.ref);

      if (entry)
        source =
          source.slice(0, reference.idSpan.start) + encodeFormulaString(entry.name) + source.slice(reference.idSpan.end);
    });
  return source;
}
