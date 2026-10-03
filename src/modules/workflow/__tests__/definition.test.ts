// The definition language and the save-time checks (wfe-to-be.md §12.2, §12.3; AUDIT/16 §3.3, §4 "definition").
import { describe, expect, it } from 'vitest';
import { canonicalJson, definitionChecksum, definitionProblems, parseDefinition, type DefinitionCatalogs } from '../definition';
import { isWorkflowError } from '../errors';

const SETTINGS = { maxReturns: null, returnExpiryWorkingDays: null, coverRole: null, rejectRequiresPair: false, rejectAuthority: ['HR_MANAGER'] };
const CATALOGS: DefinitionCatalogs = {
  fieldCatalog: { days: { type: 'number' }, kind: { type: 'enum', values: ['A', 'B'] }, from: { type: 'date' }, urgent: { type: 'boolean' }, note: { type: 'string' } },
  decisionFieldCatalog: { assetId: { type: 'string' }, amount: { type: 'number' } },
};
const hr = (id: string, extra: Record<string, unknown> = {}) => ({ type: 'stage', id, approver: { kind: 'ROLE', role: 'HR_MANAGER' }, ...extra });
const doc = (root: unknown, settings: Record<string, unknown> = {}) => ({ schemaVersion: 1, settings: { ...SETTINGS, ...settings }, root });
const seq = (...children: unknown[]) => ({ type: 'sequence', id: `s${children.length}${Math.random().toString(36).slice(2, 6)}`, children });
const problems = (d: unknown, c: DefinitionCatalogs = CATALOGS) => definitionProblems(d, c).map((p) => p.problem).join(' | ');

describe('definition schema (strict, §12.2)', () => {
  it('accepts the four node kinds, an empty sequence (the automatic path) and every Expr form', () => {
    const d = doc({
      type: 'sequence',
      id: 'root',
      children: [
        { type: 'stage', id: 'mgr', approver: { kind: 'MANAGER_CHAIN', levels: 2 }, deadline: { workingDays: 2, onDeadline: 'COVER' } },
        {
          type: 'condition',
          id: 'c',
          branches: [{ when: { all: [{ field: 'days', op: 'gt', value: 5 }, { not: { field: 'urgent', op: 'eq', value: true } }] }, node: hr('hr') }],
          otherwise: { type: 'parallel', id: 'p', join: 'ANY', branches: [hr('x'), hr('y')] },
        },
        { type: 'condition', id: 'c2', branches: [{ when: { any: [{ field: 'kind', op: 'in', value: ['A'] }, { field: 'from', op: 'exists' }] }, node: seq() }] },
      ],
    });
    expect(definitionProblems(d, CATALOGS)).toEqual([]);
    expect(definitionProblems(doc(seq()), CATALOGS)).toEqual([]);
  });

  it('refuses the money settings keys and any unknown key (DEC-PO-139), at every level', () => {
    for (const key of ['adminMoneyMode', 'alternateCollision', 'loanCancelApprovers', 'dropDeductionApprovers', 'payEffect']) {
      expect(problems(doc(seq(), { [key]: 'X' }))).toMatch(/Unrecognized key/);
    }
    expect(problems({ ...doc(seq()), money: true })).toMatch(/Unrecognized key/);
    expect(problems(doc(seq({ ...hr('a'), payEffect: 'PAY' })))).toMatch(/Unrecognized key|Invalid/);
    expect(problems(doc(seq({ type: 'stage', id: 'a', approver: { kind: 'ROLE', role: 'HR_MANAGER', amountLimit: 10 } })))).toMatch(/Unrecognized key|Invalid/);
  });

  it('refuses a parallel with one branch, an unknown role, a chain longer than 5 and a bad deadline', () => {
    expect(problems(doc({ type: 'parallel', id: 'p', join: 'ALL', branches: [hr('a')] }))).toMatch(/at least 2/);
    expect(problems(doc(seq({ type: 'stage', id: 'a', approver: { kind: 'ROLE', role: 'CEO' } })))).toMatch(/Invalid/);
    expect(problems(doc(seq({ type: 'stage', id: 'a', approver: { kind: 'MANAGER_CHAIN', levels: 6 } })))).toMatch(/less than or equal to 5/);
    expect(problems(doc(seq(hr('a', { deadline: { workingDays: 61, onDeadline: 'COVER' } }))))).toMatch(/less than or equal to 60/);
    expect(problems(doc(seq(hr('a', { deadline: { workingDays: 0, onDeadline: 'COVER' } }))))).toMatch(/greater than or equal to 1/);
  });
});

describe('save-time checks (§12.3)', () => {
  it('an unknown field, or a value / operator that does not match the field type, is refused', () => {
    const cond = (when: unknown) => doc({ type: 'condition', id: 'c', branches: [{ when, node: hr('a') }] });
    expect(problems(cond({ field: 'salary', op: 'gt', value: 1 }))).toMatch(/unknown field "salary"/);
    expect(problems(cond({ field: 'days', op: 'eq', value: 'five' }))).toMatch(/does not match the number field/);
    expect(problems(cond({ field: 'kind', op: 'eq', value: 'C' }))).toMatch(/does not match the enum field/);
    expect(problems(cond({ field: 'note', op: 'gt', value: 'a' }))).toMatch(/only for number and date/);
    expect(problems(cond({ field: 'kind', op: 'in', value: 'A' }))).toMatch(/in needs a non-empty list/);
    expect(problems(cond({ field: 'days', op: 'exists', value: 1 }))).toMatch(/exists takes no value/);
    expect(problems(cond({ field: 'days', op: 'gte' }))).toMatch(/needs a value/);
    expect(problems(cond({ field: 'from', op: 'lt', value: '2026-13-01x' }))).toMatch(/does not match the date field/);
  });

  it('a decision field is usable only after a stage that collects it; an unknown decision field is refused', () => {
    const use = { type: 'condition', id: 'c', branches: [{ when: { field: 'amount', op: 'gt', value: 100 }, node: hr('big') }] };
    expect(problems(doc({ type: 'sequence', id: 'r', children: [use, hr('a', { decisionFields: ['amount'] })] }))).toMatch(/unknown field "amount"/);
    expect(definitionProblems(doc({ type: 'sequence', id: 'r', children: [hr('a', { decisionFields: ['amount'] }), use] }), CATALOGS)).toEqual([]);
    expect(problems(doc(seq(hr('a', { decisionFields: ['iban'] }))))).toMatch(/unknown decision field "iban"/);
    // Collected on one parallel branch only: not known after the parallel.
    const par = { type: 'parallel', id: 'p', join: 'ANY', branches: [hr('a', { decisionFields: ['amount'] }), hr('b')] };
    expect(problems(doc({ type: 'sequence', id: 'r', children: [par, use] }))).toMatch(/unknown field "amount"/);
  });

  it('an unreachable branch is refused (after an always-true one, a never-true one, a repeated condition)', () => {
    const always = { all: [] };
    const never = { any: [] };
    const c = { field: 'days', op: 'gt', value: 3 };
    expect(problems(doc({ type: 'condition', id: 'c', branches: [{ when: always, node: hr('a') }, { when: c, node: hr('b') }] }))).toMatch(/earlier branch is always taken/);
    expect(problems(doc({ type: 'condition', id: 'c', branches: [{ when: never, node: hr('a') }] }))).toMatch(/never true/);
    expect(problems(doc({ type: 'condition', id: 'c', branches: [{ when: c, node: hr('a') }, { when: { op: 'gt', value: 3, field: 'days' }, node: hr('b') }] }))).toMatch(/same condition/);
    expect(problems(doc({ type: 'condition', id: 'c', branches: [{ when: { not: never }, node: hr('a') }], otherwise: hr('b') }))).toMatch(/unreachable otherwise/);
  });

  it('a path without a required decision field and without its autoDefault is refused', () => {
    const cats = { ...CATALOGS, requiredDecisionFields: ['assetId'] };
    const d = doc({ type: 'condition', id: 'c', branches: [{ when: { field: 'urgent', op: 'eq', value: true }, node: hr('a', { decisionFields: ['assetId'] }) }] });
    expect(problems(d, cats)).toMatch(/required decision field\(s\) assetId/);
    expect(definitionProblems(doc(d.root, { autoDefaults: { assetId: null } }), cats)).toEqual([]);
    expect(definitionProblems(doc({ ...(d.root as Record<string, unknown>), otherwise: hr('b', { decisionFields: ['assetId'] }) }), cats)).toEqual([]);
    expect(problems(doc(seq(), { autoDefaults: { nope: 1 } }), cats)).toMatch(/unknown decision field "nope"/);
  });

  it('the limits: depth 5, 20 stages (a MANAGER_CHAIN counts its levels), unique node ids', () => {
    let deep: unknown = hr('leaf');
    for (let i = 0; i < 5; i++) deep = { type: 'sequence', id: `d${i}`, children: [deep] };
    expect(problems(doc(deep))).toMatch(/deeper than 5/);
    const many = { type: 'sequence', id: 'r', children: Array.from({ length: 21 }, (_, i) => hr(`s${i}`)) };
    expect(problems(doc(many))).toMatch(/more than 20 stages/);
    const chains = { type: 'sequence', id: 'r', children: Array.from({ length: 5 }, (_, i) => ({ type: 'stage', id: `m${i}`, approver: { kind: 'MANAGER_CHAIN', levels: 5 } })) };
    expect(problems(doc(chains))).toMatch(/more than 20 stages/);
    expect(problems(doc({ type: 'sequence', id: 'r', children: [hr('a'), hr('a')] }))).toMatch(/duplicate node id "a"/);
  });

  it('parseDefinition throws WFE_DEFINITION_INVALID with the problems', () => {
    try {
      parseDefinition(doc({ type: 'parallel', id: 'p', join: 'ALL', branches: [hr('a')] }), CATALOGS);
      expect.unreachable();
    } catch (err) {
      expect(isWorkflowError(err, 'WFE_DEFINITION_INVALID')).toBe(true);
    }
  });
});

describe('checksum (G6)', () => {
  it('is stable when keys are reordered and changes with the content', () => {
    const a = doc(seq(hr('a')));
    const b = JSON.parse(JSON.stringify({ root: a.root, settings: { rejectAuthority: ['HR_MANAGER'], coverRole: null, rejectRequiresPair: false, returnExpiryWorkingDays: null, maxReturns: null }, schemaVersion: 1 }));
    expect(definitionChecksum(b)).toBe(definitionChecksum(a));
    expect(definitionChecksum(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(definitionChecksum(doc(seq(hr('b'))))).not.toBe(definitionChecksum(a));
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });
});
