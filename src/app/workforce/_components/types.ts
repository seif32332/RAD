// Response types of the workforce API as consumed by the pages (type-only imports; no runtime code).
import type { EmployeeSummary } from '@/app/api/workforce/_lib/views';
import type { CostLineKey, EmployeeLiabilities, EmployeeMonth, ExitCostResult, LineExplanation, MoneyTriple, RuleEvidence, RuleVersionRef, Scenario, WfFlag, WindowTotals } from '@/lib/workforce/types';

export type { EmployeeSummary };

export interface OptionsResponse {
  role: string;
  companies: Array<{ id: string; name: string }>;
  branches: Array<{ id: string; name: string }>;
  departments: Array<{ id: string; name: string }>;
  employees: Array<{ id: string; employeeNo: string | null; name: string; companyId: string | null; branchId: string | null; departmentId: string | null }>;
}

export interface SeriesPoint extends MoneyTriple {
  month: string;
  headcount: number;
}

export interface TrueCostDetail {
  summary: EmployeeSummary;
  months: EmployeeMonth[];
  byLine: Partial<Record<CostLineKey, number>>;
  liabilities: EmployeeLiabilities;
  flags: WfFlag[];
  explanations: Partial<Record<CostLineKey, LineExplanation>>;
  assumptionEvidence: Record<string, RuleEvidence>;
  rulesUsed: RuleVersionRef[];
}

export interface TrueCostResponse {
  engineVersion: string;
  disclaimer: string;
  startMonth: string;
  months: number;
  horizon: 12 | 24 | 36;
  scenario: Scenario;
  scope: { companyId: string | null; branchId: string | null; departmentId: string | null; employeeIds: string[] | null };
  totals: WindowTotals;
  headcount: number;
  series: SeriesPoint[];
  employees: EmployeeSummary[];
  total: number;
  take: number;
  skip: number;
  detail: TrueCostDetail | null;
}

export interface ExitCostResponse extends ExitCostResult {
  disclaimer: string;
  employee: { id: string; name: string; employeeNo: string | null; legalCompanyId: string | null };
  reasonMapping: { exitReason: string; terminationReason: string; certain: boolean; note: string };
  warnings: string[];
  assumptionEvidence: Record<string, RuleEvidence>;
}
