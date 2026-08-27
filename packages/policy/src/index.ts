import type { Mandate, ResourceId } from '@aipay/contracts';

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
