export type ContractValidationIssueCode =
  | 'invalid_type'
  | 'invalid_value'
  | 'invalid_format'
  | 'out_of_range'
  | 'unknown_field'
  | 'duplicate_allowed_merchant'
  | 'duplicate_allowed_category'
  | 'invalid_unicode'
  | 'invalid_validity_window'
  | 'max_per_transaction_exceeds_budget'
  | 'non_positive_unit_price'
  | 'non_positive_total'
  | 'amount_overflow'
  | 'subtotal_mismatch'
  | 'tax_exceeds_subtotal'
  | 'total_mismatch'
  | 'duplicate_reference'
  | 'invalid_timestamp_order';

export interface ContractValidationIssue {
  readonly code: ContractValidationIssueCode;
  readonly path: string;
}

export class ContractValidationError extends Error {
  readonly issues: readonly Readonly<ContractValidationIssue>[];

  constructor(
    contractName: 'Mandate' | 'Quote' | 'Transaction',
    issues: readonly ContractValidationIssue[],
  ) {
    super(`Invalid ${contractName} contract`);
    this.name = 'ContractValidationError';
    this.issues = Object.freeze(
      issues.map((issue) => Object.freeze({ code: issue.code, path: issue.path })),
    );
  }
}

function escapeJsonPointerSegment(segment: PropertyKey): string {
  return String(segment).replaceAll('~', '~0').replaceAll('/', '~1');
}

export function toJsonPointer(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '/' : `/${path.map(escapeJsonPointerSegment).join('/')}`;
}

export function mapSchemaIssueCode(code: string): ContractValidationIssueCode {
  switch (code) {
    case 'invalid_type':
      return 'invalid_type';
    case 'too_small':
    case 'too_big':
      return 'out_of_range';
    case 'unrecognized_keys':
      return 'unknown_field';
    case 'invalid_format':
      return 'invalid_format';
    default:
      return 'invalid_value';
  }
}
