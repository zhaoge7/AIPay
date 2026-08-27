import type { Mandate, Money, ResourceId } from '@aipay/contracts';

export type MerchantCategoryDenialReason = 'merchant_not_allowed' | 'category_not_allowed';

export type MerchantCategoryDecision =
  Readonly<{ allowed: true }> | Readonly<{ allowed: false; reason: MerchantCategoryDenialReason }>;

export interface MerchantCategoryRequest {
  readonly merchantId: ResourceId<'mch'>;
  readonly category: string;
}

export function evaluateMerchantCategoryPolicy(
  mandate: Pick<Mandate, 'allowedMerchantIds' | 'allowedCategories'>,
  request: MerchantCategoryRequest,
): MerchantCategoryDecision {
  if (!mandate.allowedMerchantIds.some((merchantId) => merchantId === request.merchantId)) {
    return Object.freeze({ allowed: false, reason: 'merchant_not_allowed' });
  }

  if (!mandate.allowedCategories.some((category) => category === request.category)) {
    return Object.freeze({ allowed: false, reason: 'category_not_allowed' });
  }

  return Object.freeze({ allowed: true });
}

export type AmountCountDenialReason =
  | 'non_positive_amount'
  | 'per_transaction_exceeded'
  | 'transaction_count_exceeded'
  | 'total_budget_exceeded';

export type AmountCountDecision =
  | Readonly<{
      allowed: true;
      nextSpentAmountMinor: string;
      nextCompletedTransactionCount: number;
    }>
  | Readonly<{ allowed: false; reason: AmountCountDenialReason }>;

export interface MandateUsage {
  readonly spentAmountMinor: string;
  readonly completedTransactionCount: number;
}

export function evaluateAmountCountPolicy(
  mandate: Pick<Mandate, 'maxPerTransaction' | 'totalBudget' | 'maxTransactions'>,
  usage: MandateUsage,
  amount: Readonly<Money>,
): AmountCountDecision {
  const amountMinor = BigInt(amount.amountMinor);
  const spentMinor = BigInt(usage.spentAmountMinor);

  if (amountMinor <= 0n) {
    return Object.freeze({ allowed: false, reason: 'non_positive_amount' });
  }

  if (amountMinor > BigInt(mandate.maxPerTransaction.amountMinor)) {
    return Object.freeze({ allowed: false, reason: 'per_transaction_exceeded' });
  }

  if (usage.completedTransactionCount >= mandate.maxTransactions) {
    return Object.freeze({ allowed: false, reason: 'transaction_count_exceeded' });
  }

  const nextSpent = spentMinor + amountMinor;

  if (nextSpent > BigInt(mandate.totalBudget.amountMinor)) {
    return Object.freeze({ allowed: false, reason: 'total_budget_exceeded' });
  }

  return Object.freeze({
    allowed: true,
    nextSpentAmountMinor: nextSpent.toString(),
    nextCompletedTransactionCount: usage.completedTransactionCount + 1,
  });
}

export type ApprovalDecision =
  Readonly<{ requiresConfirmation: true }> | Readonly<{ requiresConfirmation: false }>;

export function evaluateApprovalPolicy(
  mandate: Pick<Mandate, 'approvalRequiredAbove'>,
  amount: Readonly<Money>,
): ApprovalDecision {
  return Object.freeze({
    requiresConfirmation:
      BigInt(amount.amountMinor) > BigInt(mandate.approvalRequiredAbove.amountMinor),
  });
}
