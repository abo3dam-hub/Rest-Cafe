import type { Bill, Order } from '@/lib/types';
import type { PrepaidDiscount } from '@/components/pos/PrepaidCheckoutModal';

export const POSTPAID_ATTEMPT_STORAGE_KEY = 'flo.postpaid.order.attempt';

export interface PostpaidAttempt {
  userId: string;
  fingerprint: string;
  idempotencyKey: string;
  operationId?: string;
  order?: Order;
}

export interface PrepaidAttempt {
  userId: string;
  cartFingerprint: string;
  paymentFingerprint: string;
  discount: PrepaidDiscount | null;
  order?: Order;
  bill?: Bill;
  orderIdempotencyKey: string;
  paymentIdempotencyKey: string;
  operationId?: string;
}

export interface PrepaidPaymentRequest {
  payments: Array<{
    method: string;
    payment_method_id?: number;
    amount: number;
    transaction_id?: string;
  }>;
  customer_id: string | number | null;
}

export type SupportOperationFailure = {
  capture_point: string;
  operation_id: string;
  outcome: string;
  facts?: { display_code?: string; failure_class?: string };
};

export const OPERATION_REFERENCE_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const STRUCTURED_HELP_CAPTURE_POINTS: Record<string, string> = {
  'order.create:validation:order.quantity_invalid': 'fc.backend.order.create.quantity_validation',
  'order.create:validation:order.stock_insufficient': 'fc.backend.order.create.stock_validation',
  'order.create:validation:validation.rejected': 'fc.backend.order.create.other_validation',
  'order.create:persistence:persistence.failed': 'fc.backend.order.create.persistence',
  'order.create:persistence:server.internal_error': 'fc.backend.order.create.server_error',
  'order.create:completion:operation.completion_failed': 'fc.backend.order.create.completion',
  'order.create:retry_state:order.retry_state_failed': 'fc.client.order.create.retry_state_update',
  'order.create:cleanup:order.held_state.cleanup_failed':
    'fc.frontend.pos.order.create.held_cleanup',
  'order.append:validation:validation.rejected': 'fc.backend.order.append.validation',
  'order.append:persistence:persistence.failed': 'fc.backend.order.append.persistence',
  'order.append:completion:operation.completion_failed': 'fc.backend.order.append.completion',
  'payment.create:retry_state:payment.retry_state_failed':
    'fc.client.payment.create.retry_state_update',
  'payment.create:cleanup:order.held_state.cleanup_failed':
    'fc.frontend.pos.payment.create.held_cleanup',
  'order.discount:validation:discount.rejected': 'fc.backend.order.discount.validation',
  'order.discount:persistence:persistence.failed': 'fc.backend.order.discount.persistence',
  'order.discount:completion:operation.completion_failed': 'fc.backend.order.discount.completion',
  'bill.discount:validation:discount.rejected': 'fc.backend.bill.discount.validation',
  'bill.discount:persistence:persistence.failed': 'fc.backend.bill.discount.persistence',
  'bill.discount:completion:operation.completion_failed': 'fc.backend.bill.discount.completion',
  'payment.create:validation:payment.invalid': 'fc.backend.payment.create.validation',
  'payment.create:persistence:persistence.failed': 'fc.backend.payment.create.persistence',
  'payment.create:completion:operation.completion_failed': 'fc.backend.payment.create.completion',
  'bill.generate:validation:bill.order_unavailable': 'fc.backend.bill.generate.validation',
  'bill.generate:persistence:persistence.failed': 'fc.backend.bill.generate.failure',
  'bill.generate:completion:operation.completion_failed': 'fc.backend.bill.generate.completion',
  'bill.generate:retry_state:bill.retry_state_failed': 'fc.client.bill.generate.retry_state_update',
  'bill.charge.update:validation:bill.charge_rejected': 'fc.backend.bill.charge.validation',
  'bill.charge.update:persistence:persistence.failed': 'fc.backend.bill.charge.persistence',
  'bill.charge.update:completion:operation.completion_failed': 'fc.backend.bill.charge.completion',
};

/** A stored attempt missing any of these is damaged, not absent: replacing it
 * with a fresh idempotency key could duplicate an order whose response was lost. */
export const isUsablePostpaidAttempt = (attempt: PostpaidAttempt): boolean =>
  typeof attempt.fingerprint === 'string' && !!attempt.idempotencyKey;

export const isUsablePrepaidAttempt = (attempt: PrepaidAttempt): boolean =>
  typeof attempt.cartFingerprint === 'string' &&
  typeof attempt.paymentFingerprint === 'string' &&
  !!attempt.orderIdempotencyKey &&
  !!attempt.paymentIdempotencyKey;

export const parsePrepaidPaymentRequest = (serialized: string): PrepaidPaymentRequest | null => {
  try {
    const value: unknown = JSON.parse(serialized);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !== 'customer_id,payments' ||
      !Array.isArray(record.payments) ||
      record.payments.length === 0 ||
      (record.customer_id !== null &&
        typeof record.customer_id !== 'string' &&
        typeof record.customer_id !== 'number')
    )
      return null;
    const payments: PrepaidPaymentRequest['payments'] = [];
    for (const line of record.payments) {
      if (!line || typeof line !== 'object' || Array.isArray(line)) return null;
      const payment = line as Record<string, unknown>;
      const keys = Object.keys(payment).sort().join(',');
      if (
        ![
          'amount,method',
          'amount,method,payment_method_id',
          'amount,method,transaction_id',
          'amount,method,payment_method_id,transaction_id',
        ].includes(keys) ||
        typeof payment.method !== 'string' ||
        payment.method.length === 0 ||
        typeof payment.amount !== 'number' ||
        !Number.isFinite(payment.amount) ||
        payment.amount <= 0 ||
        (payment.payment_method_id !== undefined &&
          typeof payment.payment_method_id !== 'number') ||
        (payment.transaction_id !== undefined && typeof payment.transaction_id !== 'string')
      )
        return null;
      payments.push({
        method: payment.method,
        ...(payment.payment_method_id !== undefined
          ? { payment_method_id: payment.payment_method_id as number }
          : {}),
        amount: payment.amount,
        ...(payment.transaction_id !== undefined
          ? { transaction_id: payment.transaction_id as string }
          : {}),
      });
    }
    return { payments, customer_id: record.customer_id as string | number | null };
  } catch {
    return null;
  }
};
