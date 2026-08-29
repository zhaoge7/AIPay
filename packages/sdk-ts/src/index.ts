export {
  AgentClient,
  PaymentActionRequiredError,
  PaymentNotCompletedError,
  type AgentClientOptions,
  type CatalogPage,
  type CatalogService,
  type PaidCallOptions,
  type PaymentAttempt,
} from './agent.js';

export { MerchantClient, type MerchantClientOptions } from './merchant.js';

export {
  PAYMENT_NEEDED_HEADER,
  PAYMENT_PROOF_HEADER,
  createPaymentRequirement,
  decodePaymentProof,
  decodePaymentRequirement,
  encodePaymentProof,
  encodePaymentRequirement,
  type PaymentRequirement,
} from './protocol.js';

export { AIPayApiError, type FetchLike } from './http.js';

export type {
  DeliveryReceiptWire,
  PaymentProofWire,
  QuoteWire,
  ResourceId,
  TransactionWire,
} from '@aipay/contracts';
