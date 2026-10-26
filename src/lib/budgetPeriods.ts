export const BUDGET_PERIODS = ['WEEK', 'MONTH', 'YEAR'] as const
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number]
