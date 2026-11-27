// Reste — Generic Budget Calculation Engine & Category Defaults

export const DEFAULT_EXPENSE_CATEGORIES = [
  'Car',
  'Childcare',
  'Clothes',
  'Clubs and Activities',
  'Council Tax',
  'Debt Repayment',
  'Groceries',
  'Health',
  'Insurance',
  'Investments',
  'Lifestyle',
  'Others/Irregular',
  'Phone Bill',
  'Rent or Mortgage',
  'Repairs & Maintenance',
  'Savings',
  'School Meals',
  'School Trips',
  'Service Charge/Ground Rent',
  'Subscriptions',
  'Takeaways/Eating Out',
  'Transport',
  'Utilities',
];

export const DEFAULT_INCOME_CATEGORIES = [
  'Aid',
  'Business Profits',
  'Dividends',
  'Employment',
  'Grant',
  'Income Support',
  'Interest',
  'Leftover Balance',
  'Loan',
  'Main Income',
  'Other',
  'Pension',
  'Rental Income',
  'Side Hustle',
];

export const FREQUENCY_OPTIONS = [
  { value: 'monthly', label: 'Monthly', divisor: 1 },
  { value: 'bi_monthly', label: 'Bi-Monthly', divisor: 2 },
  { value: 'quarterly', label: 'Quarterly', divisor: 3 },
  { value: 'six_monthly', label: 'Every 6 Months', divisor: 6 },
  { value: 'annually', label: 'Annually', divisor: 12 },
  { value: 'four_weekly', label: '4-Weekly', divisor: 12 / 13 },
  { value: 'weekly', label: 'Weekly', divisor: 12 / 52 },
];

export function roundUpToNearest(amount, step = 50) {
  const clean = Number(Number(amount || 0).toFixed(6));
  if (clean <= 0) return 0;
  if (!step || step <= 0) return clean;
  return Math.ceil(clean / step) * step;
}

export function computeMonthlyAmount(rawCost, frequency) {
  const cost = Number(rawCost) || 0;
  switch (frequency) {
    case 'bi_monthly':
      return cost / 2;
    case 'quarterly':
      return cost / 3;
    case 'six_monthly':
      return cost / 6;
    case 'annually':
      return cost / 12;
    case 'four_weekly':
      return (cost * 13) / 12;
    case 'weekly':
      return (cost * 52) / 12;
    case 'monthly':
    default:
      return cost;
  }
}

export function getEffectiveSplitA(household, items) {
  const incomes = items.filter((i) => i.scope === 'joint' && i.section === 'income');
  const partnerAIncome = incomes.reduce((s, i) => s + Number(i.partner_a_amount || 0), 0);
  const partnerBIncome = incomes.reduce((s, i) => s + Number(i.partner_b_amount || 0), 0);
  const combinedPersonal = partnerAIncome + partnerBIncome;
  const suggestedA = combinedPersonal > 0 ? partnerAIncome / combinedPersonal : 0.5;

  let activeA = Number(household?.partner_a_split ?? 0.5);
  if (household?.split_mode === 'equal') {
    activeA = 0.5;
  } else if (household?.split_mode === 'suggested') {
    activeA = suggestedA;
  }
  activeA = Math.min(1, Math.max(0, activeA));

  return {
    activeA,
    activeB: 1 - activeA,
    suggestedA,
    suggestedB: 1 - suggestedA,
    partnerAIncome,
    partnerBIncome,
  };
}

export function computeBudgetModel(household, items, spendLogs, activeMonth) {
  const h = household || {};
  const list = Array.isArray(items) ? items : [];
  const logs = Array.isArray(spendLogs) ? spendLogs : [];

  const split = getEffectiveSplitA(h, list);
  const { activeA, activeB, suggestedA, suggestedB, partnerAIncome, partnerBIncome } = split;

  // Income
  const incomeItems = list.filter((i) => i.scope === 'joint' && i.section === 'income');
  const jointDirectIncome = incomeItems.reduce((s, i) => s + Number(i.amount || 0), 0);
  const totalHouseholdIncome = jointDirectIncome + partnerAIncome + partnerBIncome;

  // Joint Expense Sections
  const regularExpenses = list.filter((i) => i.scope === 'joint' && i.section === 'regular_expense');
  const budgetedExpenses = list.filter((i) => i.scope === 'joint' && i.section === 'budgeted_expense');
  const prepayments = list.filter((i) => i.scope === 'joint' && i.section === 'prepayment');

  const getItemMonthly = (item) => {
    if (item.section === 'prepayment') {
      const raw = item.raw_cost !== null && item.raw_cost !== undefined ? Number(item.raw_cost) : Number(item.amount || 0);
      return computeMonthlyAmount(raw, item.frequency || 'monthly');
    }
    return Number(item.amount || 0);
  };

  const getItemSplitA = (item) => {
    if (item.custom_split_a !== null && item.custom_split_a !== undefined && item.custom_split_a !== '') {
      const v = Number(item.custom_split_a);
      if (!Number.isNaN(v)) return Math.min(1, Math.max(0, v));
    }
    return activeA;
  };

  let regularTotal = 0;
  let budgetedTotal = 0;
  let prepaymentTotal = 0;
  let jointBillsA = 0;
  let jointBillsB = 0;

  const categoryTotals = {};
  const addCat = (cat, amt) => {
    const c = cat || 'Others/Irregular';
    categoryTotals[c] = (categoryTotals[c] || 0) + amt;
  };

  regularExpenses.forEach((item) => {
    const amt = getItemMonthly(item);
    const sA = getItemSplitA(item);
    regularTotal += amt;
    jointBillsA += amt * sA;
    jointBillsB += amt * (1 - sA);
    addCat(item.category, amt);
  });

  budgetedExpenses.forEach((item) => {
    const amt = getItemMonthly(item);
    const sA = getItemSplitA(item);
    budgetedTotal += amt;
    jointBillsA += amt * sA;
    jointBillsB += amt * (1 - sA);
    addCat(item.category, amt);
  });

  prepayments.forEach((item) => {
    const amt = getItemMonthly(item);
    const sA = getItemSplitA(item);
    prepaymentTotal += amt;
    jointBillsA += amt * sA;
    jointBillsB += amt * (1 - sA);
    addCat(item.category, amt);
  });

  const jointExpenseSubtotal = regularTotal + budgetedTotal + prepaymentTotal;

  // Auto-calculated Joint Account Transfers (bills rounded up to nearest £50 + optional adjustment)
  const roundStep = Number(h.transfer_round_to ?? 50);
  const roundedBaseA = roundUpToNearest(jointBillsA, roundStep);
  const roundedBaseB = roundUpToNearest(jointBillsB, roundStep);
  const jointExtraA = roundedBaseA - jointBillsA;
  const jointExtraB = roundedBaseB - jointBillsB;
  const jointOptionalA = Number(h.partner_a_joint_optional || 0);
  const jointOptionalB = Number(h.partner_b_joint_optional || 0);
  const transferA = roundedBaseA + jointOptionalA;
  const transferB = roundedBaseB + jointOptionalB;
  const jointAccountInflow = transferA + transferB + jointDirectIncome;
  const jointDisposable = jointAccountInflow - jointExpenseSubtotal;

  const computePartner = (scope, income, transfer, roundedBase, billsShare, jointExtra, jointOptional) => {
    const debts = list.filter((i) => i.scope === scope && i.section === 'debt');
    const bills = list.filter((i) => i.scope === scope && i.section === 'personal_bill');
    const savings = list.filter((i) => i.scope === scope && i.section === 'savings');
    const budgeted = list.filter((i) => i.scope === scope && i.section === 'personal_budgeted');

    const debtExpected = debts.reduce((s, i) => s + Number(i.amount || 0), 0);
    const debtActual = debts.reduce((s, i) => s + Number(i.actual_amount || 0), 0);
    const billsSubtotal = bills.reduce((s, i) => s + Number(i.amount || 0), 0);
    const savingsSubtotal = savings.reduce((s, i) => s + Number(i.amount || 0), 0);
    const budgetedExpected = budgeted.reduce((s, i) => s + Number(i.amount || 0), 0);
    const budgetedActual = budgeted.reduce((s, i) => s + Number(i.actual_amount || 0), 0);

    const nonJointOutgoings = debtExpected + billsSubtotal + savingsSubtotal + budgetedExpected;
    const totalExpenditure = transfer + nonJointOutgoings;
    const disposable = income - totalExpenditure;

    return {
      income,
      transfer,
      roundedBase,
      billsShare,
      jointExtra,
      jointOptional,
      debts,
      bills,
      savings,
      budgeted,
      debtExpected,
      debtActual,
      billsSubtotal,
      savingsSubtotal,
      budgetedExpected,
      budgetedActual,
      nonJointOutgoings,
      totalExpenditure,
      disposable,
    };
  };

  const partnerA = computePartner('partner_a', partnerAIncome, transferA, roundedBaseA, jointBillsA, jointExtraA, jointOptionalA);
  const partnerB = computePartner('partner_b', partnerBIncome, transferB, roundedBaseB, jointBillsB, jointExtraB, jointOptionalB);

  const totalHouseholdExpenditure = jointExpenseSubtotal + partnerA.nonJointOutgoings + partnerB.nonJointOutgoings;
  const totalHouseholdDisposable = totalHouseholdIncome - totalHouseholdExpenditure;

  const monthLogs = activeMonth ? logs.filter((l) => l.month_key === activeMonth) : logs;
  const potActuals = {};
  monthLogs.forEach((l) => {
    const key = l.pot_name || 'Other';
    potActuals[key] = (potActuals[key] || 0) + Number(l.amount || 0);
  });

  const potTrackers = budgetedExpenses.map((pot) => {
    const budget = Number(pot.amount || 0);
    const actual = Number(potActuals[pot.name] || 0);
    const remaining = budget - actual;
    const pct = budget > 0 ? Math.min(100, Math.max(0, (actual / budget) * 100)) : 0;
    return {
      id: pot.id,
      name: pot.name,
      category: pot.category,
      budget,
      actual,
      remaining,
      pct,
      over: actual > budget,
    };
  });

  const jointDebtItems = regularExpenses.filter((i) => i.category === 'Debt Repayment');
  const jointDebtExpected = jointDebtItems.reduce((s, i) => s + Number(i.amount || 0), 0);
  const jointDebtActual = jointDebtItems.reduce((s, i) => s + Number(i.actual_amount || 0), 0);

  const categoriesSorted = Object.entries(categoryTotals)
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total);

  return {
    split: { activeA, activeB, suggestedA, suggestedB },
    incomeItems,
    jointDirectIncome,
    partnerAIncome,
    partnerBIncome,
    totalHouseholdIncome,
    regularExpenses,
    budgetedExpenses,
    prepayments,
    regularTotal,
    budgetedTotal,
    prepaymentTotal,
    jointExpenseSubtotal,
    jointBillsA,
    jointBillsB,
    transferA,
    transferB,
    jointAccountInflow,
    jointDisposable,
    partnerA,
    partnerB,
    totalHouseholdExpenditure,
    totalHouseholdDisposable,
    monthLogs,
    potTrackers,
    jointDebtItems,
    jointDebtExpected,
    jointDebtActual,
    categoriesSorted,
  };
}
