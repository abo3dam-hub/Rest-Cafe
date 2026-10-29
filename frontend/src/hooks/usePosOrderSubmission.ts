'use client';

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { useCartStore } from '@/store/cart';
import { useHeldOrdersStore } from '@/store/held-orders';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { usePosPrinting, type PosPrintingFailureEntry } from '@/hooks/usePosPrinting';
import { cartItemToOrderItem } from '@/lib/cart-order-item';
import {
  captureClientOperationFailure,
  createOperationReference,
  operationHeaders,
} from '@/lib/api';
import {
  buildAppendItemsFingerprint,
  clearAppendAttempt,
  createSafeAppendAttemptStorage,
  getAppendAttemptStorageKey,
  getOrCreateAppendAttempt,
  LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY,
  getPostpaidOrderAttemptStorageKey,
  migrateLegacyAppendAttempt,
  readAppendAttempt,
  type AppendAttempt,
  type AppendAttemptStorage,
} from '@/lib/append-attempt';
import {
  PREPAID_ATTEMPT_STORAGE_KEY,
  OrderAttemptStorageError,
  classifyOrderRequestFailure,
  clearOrderAttempt,
  getPrepaidOrderAttemptStorageKey,
  isSupportedFailureOperation,
  persistOrderAttempt,
  readOrderAttempt,
} from '@/lib/order-attempt';
import {
  OPERATION_REFERENCE_V4,
  POSTPAID_ATTEMPT_STORAGE_KEY,
  STRUCTURED_HELP_CAPTURE_POINTS,
  isUsablePostpaidAttempt,
  isUsablePrepaidAttempt,
  parsePrepaidPaymentRequest,
  type PostpaidAttempt,
  type PrepaidAttempt,
  type SupportOperationFailure,
} from '@/lib/pos/order-attempts';
import type { PrepaidPayment, PrepaidDiscount } from '@/components/pos/PrepaidCheckoutModal';
import type { Bill, Order, Table } from '@/lib/types';

export interface PosOrderSubmissionSupportError {
  title: string;
  subject: string;
  code: string;
  message: string;
  nextStep: string;
  operation: string;
  stage: string;
  outcome: string;
  classification?: string;
  reasonCode?: string;
  correlationId?: string;
  operationFailure?: SupportOperationFailure;
  ticketCorrelationId: string;
  clientTicketId: string;
  payload: Record<string, unknown>;
}

export interface UsePosOrderSubmissionOptions {
  pendingOrder: Order | null;
  setPendingOrder: Dispatch<SetStateAction<Order | null>>;
  paymentBill: Bill | null;
  setPaymentBill: Dispatch<SetStateAction<Bill | null>>;
  setCheckoutTable: Dispatch<SetStateAction<Table | null>>;
  setCheckoutOverridePin: Dispatch<SetStateAction<string | undefined>>;
  setSubmitting: Dispatch<SetStateAction<boolean>>;
  setMobileCartOpen: Dispatch<SetStateAction<boolean>>;
  setShowPrepaidCheckout: Dispatch<SetStateAction<boolean>>;
  setPrepaidModalAttempt: Dispatch<SetStateAction<PrepaidAttempt | null>>;
  setCardTransactionIdRequired: Dispatch<SetStateAction<boolean>>;
  refreshTables: () => Promise<void>;
  validateOrderPreflight: () => boolean;
  shouldTakePaymentNow: boolean;
  isServerRole: boolean;
}

export interface UsePosOrderSubmissionResult {
  supportError: PosOrderSubmissionSupportError | null;
  setSupportError: Dispatch<SetStateAction<PosOrderSubmissionSupportError | null>>;
  handlePlaceOrder: () => Promise<void>;
  handlePrepaidCheckout: (
    payments: PrepaidPayment[],
    walletAmount: number,
    discount: PrepaidDiscount | null,
  ) => Promise<void>;
  handleAddCartToOrder: (table: Table, order: Order) => Promise<void>;
  handlePaymentComplete: () => Promise<void>;
  printBillForTenant: (
    bill: Bill,
    force?: boolean,
    reservedWindow?: Window | null,
  ) => Promise<void>;
}

/** POS order submission, moved from the POS page without behavior change. */
export function usePosOrderSubmission({
  pendingOrder,
  setPendingOrder,
  paymentBill,
  setPaymentBill,
  setCheckoutTable,
  setCheckoutOverridePin,
  setSubmitting,
  setMobileCartOpen,
  setShowPrepaidCheckout,
  setPrepaidModalAttempt,
  setCardTransactionIdRequired,
  refreshTables,
  validateOrderPreflight,
  shouldTakePaymentNow,
  isServerRole,
}: UsePosOrderSubmissionOptions): UsePosOrderSubmissionResult {
  const router = useRouter();
  const { user } = useAuthStore();
  const cart = useCartStore();
  const heldOrders = useHeldOrdersStore();
  const t = useTranslations('pos');
  const tExpenses = useTranslations('expenses');
  const currencyFmt = useFormatCurrency();

  const [supportError, setSupportError] = useState<PosOrderSubmissionSupportError | null>(null);
  const activeUserId = user?.id == null ? null : String(user.id);
  const prepaidAttemptRef = useRef<PrepaidAttempt | null>(null);
  const prepaidAttemptKeyRef = useRef<string | null>(null);
  const postpaidAttemptRef = useRef<PostpaidAttempt | null>(null);
  const postpaidAttemptKeyRef = useRef<string | null>(null);
  const postpaidAttemptWasLegacyRef = useRef(false);
  const addItemsAttemptRef = useRef<AppendAttempt | null>(null);
  // Counts support dialogs raised during a submit so the waiter auto-return
  // to the map never unmounts one (see the end of handlePlaceOrder).
  const supportErrorCountRef = useRef(0);
  const appendRecoveryStartedUsersRef = useRef<Set<string>>(new Set());
  const appendAttemptStorageRef = useRef<AppendAttemptStorage | null>(null);

  const getAppendAttemptStorage = (): AppendAttemptStorage => {
    if (appendAttemptStorageRef.current) return appendAttemptStorageRef.current;
    let browserStorage: AppendAttemptStorage | null = null;
    let sessionStorage: AppendAttemptStorage | null = null;
    try {
      if (typeof window !== 'undefined') browserStorage = window.localStorage;
    } catch {
      // Private/restricted renderers may throw while reading localStorage.
    }
    try {
      if (typeof window !== 'undefined') sessionStorage = window.sessionStorage;
    } catch {
      // Session storage may also be restricted.
    }
    appendAttemptStorageRef.current = createSafeAppendAttemptStorage(
      browserStorage,
      sessionStorage,
    );
    return appendAttemptStorageRef.current;
  };

  const readPostpaidAttempt = () => {
    if (typeof window === 'undefined') return null;
    const storage = getAppendAttemptStorage();
    let sharedLegacyAppendRetained = false;
    try {
      const migratedAppend = migrateLegacyAppendAttempt(storage, {
        userId: activeUserId || undefined,
      });
      sharedLegacyAppendRetained =
        migratedAppend !== null && storage.getItem(LEGACY_POSTPAID_ATTEMPT_STORAGE_KEY) !== null;
    } catch {
      throw new OrderAttemptStorageError();
    }
    if (postpaidAttemptRef.current?.userId === activeUserId) return postpaidAttemptRef.current;
    postpaidAttemptRef.current = null;
    postpaidAttemptKeyRef.current = null;
    postpaidAttemptWasLegacyRef.current = false;
    if (activeUserId) {
      const userStorageKey = getPostpaidOrderAttemptStorageKey(activeUserId);
      const scoped = readOrderAttempt<PostpaidAttempt>(storage, userStorageKey, activeUserId, {
        isValid: isUsablePostpaidAttempt,
      });
      if (scoped) {
        postpaidAttemptRef.current = scoped;
        postpaidAttemptKeyRef.current = userStorageKey;
        return scoped;
      }
    }
    const legacy = sharedLegacyAppendRetained
      ? null
      : readOrderAttempt<PostpaidAttempt>(
          storage,
          POSTPAID_ATTEMPT_STORAGE_KEY,
          activeUserId || '',
          {
            sharedKey: true,
            isValid: isUsablePostpaidAttempt,
          },
        );
    if (legacy) {
      postpaidAttemptRef.current = legacy;
      postpaidAttemptKeyRef.current = POSTPAID_ATTEMPT_STORAGE_KEY;
      postpaidAttemptWasLegacyRef.current = true;
    }
    return postpaidAttemptRef.current;
  };
  /** Only advance the in-memory attempt after a verified write: keys that never
   * reached a backend must not be executed from memory either. */
  const savePostpaidAttempt = (attempt: PostpaidAttempt): boolean => {
    const previous = postpaidAttemptRef.current;
    if (!activeUserId) return false;
    const storageKey = getPostpaidOrderAttemptStorageKey(activeUserId);
    try {
      persistOrderAttempt(getAppendAttemptStorage(), storageKey, attempt);
    } catch {
      postpaidAttemptRef.current = previous;
      return false;
    }
    postpaidAttemptRef.current = attempt;
    postpaidAttemptKeyRef.current = storageKey;
    return true;
  };
  const clearPostpaidAttempt = () => {
    const completedAttempt = postpaidAttemptRef.current;
    const storageKeys = [
      postpaidAttemptKeyRef.current,
      postpaidAttemptWasLegacyRef.current ? POSTPAID_ATTEMPT_STORAGE_KEY : null,
    ];
    if (!completedAttempt) {
      postpaidAttemptKeyRef.current = null;
      postpaidAttemptWasLegacyRef.current = false;
      return true;
    }
    const storage = getAppendAttemptStorage();
    let cleared = true;
    for (const storageKey of storageKeys) {
      // The order is already placed: report a cleanup problem without turning a
      // completed sale into a failure.
      if (storageKey && !clearOrderAttempt(storage, storageKey, completedAttempt)) {
        console.error('Failed to close the postpaid retry attempt after the order was placed');
        cleared = false;
      }
    }
    if (cleared) {
      postpaidAttemptRef.current = null;
      postpaidAttemptKeyRef.current = null;
      postpaidAttemptWasLegacyRef.current = false;
    }
    return cleared;
  };

  const stripPrepaidDiscountPin = (attempt: PrepaidAttempt): PrepaidAttempt => {
    if (!attempt.discount) return attempt;
    if (!('override_pin' in attempt.discount) && !('approver_id' in attempt.discount))
      return attempt;
    const safeDiscount = { ...attempt.discount };
    delete safeDiscount.override_pin;
    delete safeDiscount.approver_id;
    return { ...attempt, discount: safeDiscount };
  };

  const readPrepaidAttempt = (): PrepaidAttempt | null => {
    if (prepaidAttemptRef.current?.userId === activeUserId) return prepaidAttemptRef.current;
    prepaidAttemptRef.current = null;
    prepaidAttemptKeyRef.current = null;
    if (typeof window === 'undefined' || !activeUserId) return null;
    const storage = getAppendAttemptStorage();
    const scopedKey = getPrepaidOrderAttemptStorageKey(activeUserId);
    const scoped = readOrderAttempt<PrepaidAttempt>(storage, scopedKey, activeUserId, {
      isValid: isUsablePrepaidAttempt,
    });
    if (scoped) {
      const safeAttempt = stripPrepaidDiscountPin(scoped);
      if (safeAttempt !== scoped) {
        if (!savePrepaidAttempt(safeAttempt)) throw new OrderAttemptStorageError();
      } else {
        prepaidAttemptRef.current = safeAttempt;
        prepaidAttemptKeyRef.current = scopedKey;
      }
      return safeAttempt;
    }
    // Builds before user-scoped attempts shared one global prepaid record.
    // Adopt it only for its owner and leave a foreign record untouched: clearing
    // another cashier's pending retry is what forced fresh keys onto a request
    // that may already have committed.
    const legacy = readOrderAttempt<PrepaidAttempt>(
      storage,
      PREPAID_ATTEMPT_STORAGE_KEY,
      activeUserId,
      {
        sharedKey: true,
        isValid: isUsablePrepaidAttempt,
      },
    );
    if (!legacy) return null;
    const migrated = stripPrepaidDiscountPin(legacy);
    if (!savePrepaidAttempt(migrated)) throw new OrderAttemptStorageError();
    clearOrderAttempt(storage, PREPAID_ATTEMPT_STORAGE_KEY, migrated);
    return migrated;
  };
  const savePrepaidAttempt = (attempt: PrepaidAttempt): boolean => {
    const previous = prepaidAttemptRef.current;
    if (!activeUserId) return false;
    const storageKey = getPrepaidOrderAttemptStorageKey(activeUserId);
    const safeAttempt = stripPrepaidDiscountPin(attempt);
    try {
      persistOrderAttempt(getAppendAttemptStorage(), storageKey, safeAttempt);
    } catch {
      prepaidAttemptRef.current = previous;
      return false;
    }
    prepaidAttemptRef.current = safeAttempt;
    prepaidAttemptKeyRef.current = storageKey;
    return true;
  };
  /** Intermediate prepaid states are persisted too: a request that runs under a
   * key the next run cannot replay can capture the same payment twice. */
  const requirePrepaidAttemptSaved = (attempt: PrepaidAttempt) => {
    if (!savePrepaidAttempt(attempt)) throw new OrderAttemptStorageError();
  };
  const clearPrepaidAttempt = () => {
    const completedAttempt = prepaidAttemptRef.current;
    const storageKey = prepaidAttemptKeyRef.current;
    if (!completedAttempt || !storageKey) {
      prepaidAttemptRef.current = null;
      prepaidAttemptKeyRef.current = null;
      return true;
    }
    // The payment is already captured: report a cleanup problem without turning
    // a completed sale into a failure.
    if (!clearOrderAttempt(getAppendAttemptStorage(), storageKey, completedAttempt)) {
      console.error('Failed to close the prepaid retry attempt after the payment was captured');
      return false;
    }
    prepaidAttemptRef.current = null;
    prepaidAttemptKeyRef.current = null;
    return true;
  };

  /** Keeps bounded operation facts for the deliberate help flow only. */
  const reportOrderFailure = (entry: PosPrintingFailureEntry) => {
    const correlationId =
      entry.correlationId && OPERATION_REFERENCE_V4.test(entry.correlationId)
        ? entry.correlationId
        : undefined;
    const ticketCorrelationId = correlationId || createOperationReference() || '';
    const clientTicketId = createOperationReference() || '';
    supportErrorCountRef.current += 1;
    setSupportError({
      title: entry.title,
      subject: 'Rest&Cafe order problem',
      code: entry.code,
      message: entry.message,
      nextStep: entry.nextStep,
      operation: entry.operation,
      stage: entry.stage,
      outcome: entry.outcome,
      classification: entry.classification,
      reasonCode: entry.reasonCode || undefined,
      correlationId,
      operationFailure:
        entry.operationFailure?.operation_id === correlationId ? entry.operationFailure : undefined,
      ticketCorrelationId,
      clientTicketId,
      payload: {
        event_code: entry.code,
        message: entry.detail,
        category: 'bug',
        diagnostics: {
          operation: entry.operation,
          stage: entry.stage,
          outcome: entry.outcome,
          classification: entry.classification,
          reason_code: entry.reasonCode || entry.code,
          correlation_id: correlationId,
          http_status: entry.status,
        },
        ...(entry.operationFailure?.operation_id === correlationId
          ? { operation_failure: entry.operationFailure }
          : {}),
      },
    });
    toast.error(entry.message);
  };

  const reportOrderStorageFailure = (
    title: string,
    operation: 'order.create' | 'payment.create' | 'order.append' = 'order.create',
    correlationId: string | null = null,
  ) => {
    if (correlationId)
      void captureClientOperationFailure({ operation, phase: 'retry_storage', correlationId });
    const message = t('orderStorageUnavailable');
    reportOrderFailure({
      code:
        operation === 'payment.create'
          ? 'payment.retry_state.storage_unavailable'
          : operation === 'order.append'
            ? 'order.append.retry_state.storage_unavailable'
            : 'order.retry_state.storage_unavailable',
      title,
      message,
      nextStep: t('orderStorageNextStep'),
      detail: 'Retry state could not be persisted before the request was sent',
      status: null,
      operation,
      stage: 'local_storage',
      outcome: 'not_applied',
      correlationId,
      operationFailure: correlationId
        ? {
            capture_point:
              operation === 'payment.create'
                ? 'fc.frontend.pos.payment.create.retry_storage'
                : operation === 'order.append'
                  ? 'fc.frontend.pos.order.append.retry_storage'
                  : 'fc.frontend.pos.order.create.retry_storage',
            operation_id: correlationId,
            outcome: 'not_applied',
          }
        : undefined,
    });
  };

  const reportOrderRequestFailure = (
    error: unknown,
    title: string,
    operation: string,
    stage: string,
    correlationId: string | null,
  ) => {
    const registeredOperation = isSupportedFailureOperation(operation) ? operation : 'order.create';
    const expectedReference = operation === registeredOperation ? correlationId || '' : '';
    const failure = classifyOrderRequestFailure(error, {
      operation: registeredOperation,
      correlationId: expectedReference,
    });
    const helpCapturePoint = failure.trusted
      ? STRUCTURED_HELP_CAPTURE_POINTS[
          `${failure.operation}:${failure.stage}:${failure.reasonCode}`
        ]
      : undefined;
    const hasResponse = !!(error as { response?: unknown } | null)?.response;
    const frontendTransportOperation =
      operation === 'order.create' ||
      operation === 'payment.create' ||
      operation === 'order.append';
    const failureClass = (() => {
      const code = (error as { code?: unknown } | null)?.code;
      return code === 'ECONNABORTED' || code === 'ETIMEDOUT'
        ? 'timeout'
        : code === 'ENOTFOUND' || code === 'EAI_AGAIN'
          ? 'dns'
          : code === 'ECONNREFUSED'
            ? 'connection_refused'
            : typeof navigator !== 'undefined' && !navigator.onLine
              ? 'offline'
              : 'unreachable';
    })();
    const clientFailurePhase =
      operation === 'order.append' && stage === 'recovery' ? 'recovery' : 'transport';
    const clientCapturePoint = `fc.frontend.pos.${operation}.${clientFailurePhase}`;
    if (!hasResponse && correlationId && frontendTransportOperation) {
      void captureClientOperationFailure({
        operation: operation as 'order.create' | 'payment.create' | 'order.append',
        phase: clientFailurePhase,
        correlationId,
        failureClass,
      });
    }
    const helpOperationFailure =
      !hasResponse && correlationId && frontendTransportOperation
        ? {
            capture_point: clientCapturePoint,
            operation_id: correlationId,
            outcome: 'unknown',
            ...(clientFailurePhase === 'transport'
              ? { facts: { failure_class: failureClass } }
              : {}),
          }
        : helpCapturePoint && failure.correlationId
          ? {
              capture_point: helpCapturePoint,
              operation_id: failure.correlationId,
              outcome: failure.outcome || 'unknown',
              ...(failure.displayCode ? { facts: { display_code: failure.displayCode } } : {}),
            }
          : undefined;
    const reasonMessages: Record<string, string> = {
      'order.quantity_invalid': t('orderQuantityInvalid'),
      'order.stock_insufficient': t('orderStockInsufficient'),
      'validation.rejected': t('orderValidationRejected'),
      'bill.order_unavailable': t('operationNotSaved'),
      'payment.invalid': t('paymentValidationRejected'),
      'discount.rejected': t('operationCorrectAndRetry'),
    };
    const discountMessages: Record<string, string> = {
      invalid_type: t('discountInvalidType'),
      invalid_value: t('discountInvalidValue'),
      disabled: t('discountDisabled'),
      type_disabled: t('discountTypeDisabled'),
      limit_exceeded: t('discountLimitExceeded'),
      order_not_discountable: t('orderNotDiscountable'),
      bill_not_discountable: t('billNotDiscountable'),
      split_check: t('splitCheckDiscountUnavailable'),
      refunded: t('refundedDiscountUnavailable'),
      paid: t('paidDiscountUnavailable'),
    };
    const paymentMessages: Record<string, string> = {
      transaction_reference_used: t('paymentTransactionReferenceUsed'),
      transaction_reference_reused: t('paymentTransactionReferenceReused'),
      bill_refunded: t('paymentBillRefunded'),
      bill_already_paid: t('paymentBillAlreadyPaid'),
      customer_mismatch: t('paymentCustomerMismatch'),
      customer_unavailable: t('paymentCustomerUnavailable'),
      wallet_customer_required: t('paymentWalletCustomerRequired'),
      amount_required: t('paymentAmountRequired'),
      non_cash_exceeds_balance: t('paymentAboveBalance'),
      cash_reference_zero_applied: t('paymentCashReferenceZeroApplied'),
      wallet_insufficient: t('paymentWalletInsufficient'),
      kitchen_undelivered: t('kitchenDeliveryOverridePrompt'),
      idempotency_conflict: t('paymentIdempotencyConflict'),
      payment_method_unavailable: t('paymentMethodUnavailable'),
      payment_input_invalid: t('paymentInputInvalid'),
      cash_session_required: tExpenses('cashSessionClosed'),
      card_transaction_id_required: t('cardTransactionIdMissing'),
    };
    const confirmedNotApplied = failure.trusted && failure.outcome === 'not_applied';
    if (confirmedNotApplied && failure.displayCode === 'card_transaction_id_required') {
      setCardTransactionIdRequired(true);
    }
    const expectedRejection =
      confirmedNotApplied && failure.classification === 'expected_rejection';
    const confirmedNotSaved =
      confirmedNotApplied && failure.classification === 'unexpected_failure';
    const paymentRejection = expectedRejection && failure.reasonCode === 'payment.invalid';
    const appliedPayment =
      failure.trusted && failure.operation === 'payment.create' && failure.outcome === 'applied';
    const paymentNeedsStatusCheck =
      paymentRejection &&
      ['bill_refunded', 'bill_already_paid', 'idempotency_conflict'].includes(
        failure.displayCode || '',
      );
    const unknownMessage =
      operation === 'order.discount'
        ? t('discountOutcomeUnknown')
        : operation === 'bill.discount'
          ? t('discountOutcomeUnknown')
          : operation === 'bill.generate'
            ? t('billOutcomeUnknown')
            : operation === 'order.append'
              ? t('appendOutcomeUnknown')
              : t('operationOutcomeUnknown');
    const isAddonOrGeneralValidation =
      failure.reasonCode === 'order.addon_selection_required' ||
      failure.reasonCode === 'order.addon_unavailable' ||
      failure.reasonCode === 'order.stock_insufficient' ||
      failure.reasonCode === 'validation.rejected';
    const rejectionMessage =
      isAddonOrGeneralValidation && failure.serverError
        ? failure.serverError
        : failure.reasonCode
          ? reasonMessages[failure.reasonCode] ||
            failure.serverError ||
            t('operationOutcomeUnknown')
          : t('operationOutcomeUnknown');
    reportOrderFailure({
      code: failure.code,
      title,
      message: paymentRejection
        ? failure.displayCode
          ? paymentMessages[failure.displayCode] || t('paymentValidationRejected')
          : t('paymentValidationRejected')
        : expectedRejection && failure.reasonCode
          ? failure.displayCode
            ? discountMessages[failure.displayCode] || t('operationOutcomeUnknown')
            : rejectionMessage
          : confirmedNotSaved
            ? t('operationNotSaved')
            : appliedPayment
              ? t('paymentCompletionApplied')
              : failure.outcome === 'unknown'
                ? unknownMessage
                : t('operationMayHaveCompleted'),
      nextStep: paymentNeedsStatusCheck
        ? t('operationCheckBeforeRetry')
        : paymentRejection
          ? t('paymentCorrectAndRetry')
          : expectedRejection
            ? t('operationCorrectAndRetry')
            : confirmedNotSaved
              ? t('operationNotSavedNextStep')
              : t('operationCheckBeforeRetry'),
      detail: failure.detail,
      status: failure.status,
      operation: registeredOperation,
      stage: failure.trusted
        ? failure.stage || stage
        : hasResponse && (stage === 'submission' || stage === 'order_submission')
          ? 'response_unconfirmed'
          : stage,
      outcome: failure.outcome || 'unknown',
      classification: failure.classification || undefined,
      reasonCode: failure.reasonCode,
      correlationId,
      operationFailure: helpOperationFailure,
    });
  };

  const newIdempotencyKey = () =>
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `payment-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const { printKotIfEnabled, fetchLatestBill, printBillForTenant } = usePosPrinting({
    reportOrderFailure,
  });

  // Replay persisted append attempt on reload to recover lost in-flight responses.
  useEffect(() => {
    if (!activeUserId || appendRecoveryStartedUsersRef.current.has(activeUserId)) return;

    let pendingAttempt: AppendAttempt | null = null;
    try {
      pendingAttempt = readAppendAttempt(getAppendAttemptStorage(), { userId: activeUserId });
    } catch {
      window.setTimeout(
        () =>
          reportOrderStorageFailure(
            t('addItemsFailed'),
            'order.append',
            createOperationReference(),
          ),
        0,
      );
      return;
    }
    if (!pendingAttempt) return;

    const operationId = pendingAttempt.operationId || createOperationReference();
    if (operationId && pendingAttempt.operationId !== operationId) {
      pendingAttempt = { ...pendingAttempt, operationId };
      try {
        getAppendAttemptStorage().setItem(
          getAppendAttemptStorageKey(activeUserId),
          JSON.stringify(pendingAttempt),
        );
      } catch {
        window.setTimeout(
          () => reportOrderStorageFailure(t('addItemsFailed'), 'order.append', operationId),
          0,
        );
        return;
      }
    }
    appendRecoveryStartedUsersRef.current.add(activeUserId);
    addItemsAttemptRef.current = pendingAttempt;
    api
      .post(
        `/orders/${pendingAttempt.orderId}/items`,
        {
          items: pendingAttempt.items,
          special_instructions: pendingAttempt.specialInstructions,
        },
        {
          headers: {
            'Idempotency-Key': pendingAttempt.idempotencyKey,
            ...operationHeaders(operationId),
          },
        },
      )
      .then(() => {
        const storage = getAppendAttemptStorage();
        const cleared = clearAppendAttempt(storage, pendingAttempt!);
        if (addItemsAttemptRef.current?.idempotencyKey !== pendingAttempt!.idempotencyKey) return;
        addItemsAttemptRef.current = null;
        // Do not clear cart or checkout state that may have been started while
        // recovery was in flight. A reload starts empty; any current UI is newer.
        toast.success(
          t('itemsAddedToOrder', {
            number: pendingAttempt!.orderNumber || pendingAttempt!.orderId,
          }),
        );
        if (!cleared) {
          reportOrderFailure({
            code: 'order.append.retry_state.cleanup_failed',
            title: t('itemsAddedToOrder', {
              number: pendingAttempt!.orderNumber || pendingAttempt!.orderId,
            }),
            message: t('appendCompleteCleanupFailed'),
            nextStep: t('appendCompleteCheckOrders'),
            detail: 'Items were added to the order but local retry state could not be cleared',
            status: null,
            operation: 'order.append',
            stage: 'cleanup',
            outcome: 'applied',
            reasonCode: 'order.append.retry_state.cleanup_failed',
            correlationId: pendingAttempt!.operationId,
          });
        }
        refreshTables();
      })
      .catch((error) => {
        reportOrderRequestFailure(
          error,
          t('addItemsFailed'),
          'order.append',
          'recovery',
          pendingAttempt!.operationId || null,
        );
      });
    // Runs once per user session to recover persisted append state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeUserId]);

  const buildCurrentCartFingerprint = (orderItems = cart.items.map(cartItemToOrderItem)) =>
    JSON.stringify({
      table_id: cart.tableId,
      customer_id: cart.customerId,
      type: cart.orderType,
      guest_count: cart.guestCount,
      special_instructions: cart.orderNotes,
      online_platform: cart.orderType === 'online' ? cart.onlinePlatform : undefined,
      external_order_id: cart.orderType === 'online' ? cart.externalOrderId : undefined,
      delivery_address:
        cart.orderType === 'delivery' ? cart.deliveryAddress || undefined : undefined,
      expected_payment_method:
        cart.orderType === 'delivery' ? cart.expectedPaymentMethod || undefined : undefined,
      expected_payment_method_id:
        cart.orderType === 'delivery' ? (cart.expectedPaymentMethodId ?? undefined) : undefined,
      delivery_note: cart.orderType === 'delivery' ? cart.deliveryNote || undefined : undefined,
      items: orderItems,
      waived_charge_ids: Array.from(cart.waivedChargeIds),
      opted_in_charge_ids: Array.from(cart.optedInChargeIds),
    });

  const handlePlaceOrder = async () => {
    if (!validateOrderPreflight()) return;

    // Prepaid stores collect payment before finishing the order.
    if (shouldTakePaymentNow) {
      let matchingAttempt: PrepaidAttempt | null = null;
      try {
        const storedAttempt = readPrepaidAttempt();
        const cartFingerprint = buildCurrentCartFingerprint();
        if (
          storedAttempt &&
          storedAttempt.userId === activeUserId &&
          storedAttempt.cartFingerprint === cartFingerprint &&
          storedAttempt.orderIdempotencyKey &&
          storedAttempt.paymentIdempotencyKey
        ) {
          matchingAttempt = storedAttempt;
        }
      } catch {
        // Storage failures are reported when checkout is confirmed.
      }
      setPrepaidModalAttempt(matchingAttempt);
      setShowPrepaidCheckout(true);
      return;
    }

    // Postpaid store / unpaid order → place order, kitchen gets the ticket, payment collected later
    setSubmitting(true);
    const supportErrorsAtStart = supportErrorCountRef.current;
    let failureOperation = pendingOrder ? 'order.append' : 'order.create';
    let failureStage = 'submission';
    let failureCorrelationId: string | null = null;
    try {
      let orderForKot: Order;

      if (pendingOrder) {
        // Add new items to an existing order with a durable retry key.
        const newItems = cart.items.map(cartItemToOrderItem);
        const specialInstructions = cart.orderNotes || undefined;
        const itemFingerprint = buildAppendItemsFingerprint(
          pendingOrder.id,
          newItems,
          specialInstructions,
        );
        const storage = getAppendAttemptStorage();
        const candidateOperationId = createOperationReference() || undefined;
        failureCorrelationId = candidateOperationId || null;
        let itemAttempt = getOrCreateAppendAttempt(storage, {
          userId: activeUserId || '',
          orderId: pendingOrder.id,
          fingerprint: itemFingerprint,
          createKey: newIdempotencyKey,
          items: newItems,
          specialInstructions,
          orderNumber: pendingOrder.order_number,
          operationId: candidateOperationId,
        });
        if (!itemAttempt.operationId) {
          const operationId = createOperationReference();
          if (operationId) {
            itemAttempt = { ...itemAttempt, operationId };
            try {
              storage.setItem(
                getAppendAttemptStorageKey(itemAttempt.userId),
                JSON.stringify(itemAttempt),
              );
            } catch {
              throw new OrderAttemptStorageError();
            }
          }
        }
        failureCorrelationId = itemAttempt.operationId || null;
        addItemsAttemptRef.current = itemAttempt;
        failureStage = 'append_items';
        const { data } = await api.post(
          `/orders/${pendingOrder.id}/items`,
          { items: newItems, special_instructions: specialInstructions },
          {
            headers: {
              'Idempotency-Key': itemAttempt.idempotencyKey,
              ...operationHeaders(itemAttempt.operationId),
            },
          },
        );
        toast.success(t('itemsAddedToOrder', { number: pendingOrder.order_number }));
        const updatedOrder = data.order as Order;
        const existingItemIds = new Set((pendingOrder.items || []).map((item) => Number(item.id)));
        const appendedItems = (updatedOrder.items || []).filter(
          (item) => !existingItemIds.has(Number(item.id)),
        );
        orderForKot =
          appendedItems.length > 0 ? { ...updatedOrder, items: appendedItems } : updatedOrder;
        if (!clearAppendAttempt(storage, itemAttempt)) {
          if (itemAttempt.operationId)
            void captureClientOperationFailure({
              operation: 'order.append',
              phase: 'retry_cleanup',
              correlationId: itemAttempt.operationId,
            });
          reportOrderFailure({
            code: 'order.append.retry_state.cleanup_failed',
            title: t('itemsAddedToOrder', { number: pendingOrder.order_number }),
            message: t('appendCompleteCleanupFailed'),
            nextStep: t('appendCompleteCheckOrders'),
            detail: 'Items were added to the order but local retry state could not be cleared',
            status: null,
            operation: 'order.append',
            stage: 'cleanup',
            outcome: 'applied',
            reasonCode: 'order.append.retry_state.cleanup_failed',
            correlationId: itemAttempt.operationId,
          });
        }
        addItemsAttemptRef.current = null;
        setPendingOrder(null);
      } else {
        const orderPayload = {
          table_id: cart.tableId,
          customer_id: cart.customerId,
          type: cart.orderType,
          guest_count: cart.guestCount,
          special_instructions: cart.orderNotes || undefined,
          online_platform:
            cart.orderType === 'online' ? cart.onlinePlatform || undefined : undefined,
          external_order_id:
            cart.orderType === 'online' ? cart.externalOrderId || undefined : undefined,
          delivery_address:
            cart.orderType === 'delivery' ? cart.deliveryAddress || undefined : undefined,
          expected_payment_method:
            cart.orderType === 'delivery' ? cart.expectedPaymentMethod || undefined : undefined,
          expected_payment_method_id:
            cart.orderType === 'delivery' ? (cart.expectedPaymentMethodId ?? undefined) : undefined,
          delivery_note: cart.orderType === 'delivery' ? cart.deliveryNote || undefined : undefined,
          waived_charge_ids: Array.from(cart.waivedChargeIds),
          opted_in_charge_ids: Array.from(cart.optedInChargeIds),
          items: cart.items.map(cartItemToOrderItem),
        };
        const orderFingerprint = JSON.stringify(orderPayload);
        const priorOrderAttempt = readPostpaidAttempt();
        if (
          priorOrderAttempt?.userId === activeUserId &&
          priorOrderAttempt.fingerprint === orderFingerprint &&
          priorOrderAttempt.order
        ) {
          reportOrderFailure({
            code: 'order.retry_state.cleanup_failed',
            title: t('orderPlaced', { number: priorOrderAttempt.order.order_number }),
            message: t('saleCompleteCleanupFailed'),
            nextStep: t('saleCompleteCheckOrders'),
            detail:
              'This matching order attempt already has a confirmed order and cannot be reused for a new sale',
            status: null,
            operation: 'order.create',
            stage: 'cleanup',
            outcome: 'applied',
            reasonCode: 'order.retry_state.cleanup_failed',
            correlationId: priorOrderAttempt.operationId,
          });
          return;
        }
        failureOperation = 'order.create';
        failureStage = 'order_submission';
        const orderAttempt: PostpaidAttempt =
          priorOrderAttempt?.userId === activeUserId &&
          priorOrderAttempt.fingerprint === orderFingerprint
            ? priorOrderAttempt
            : {
                userId: activeUserId || '',
                fingerprint: orderFingerprint,
                idempotencyKey: newIdempotencyKey(),
                operationId: createOperationReference() || undefined,
              };
        const operationId = orderAttempt.operationId || createOperationReference();
        failureCorrelationId = operationId;
        const attemptWithOperationId = operationId
          ? { ...orderAttempt, operationId }
          : orderAttempt;
        if (!savePostpaidAttempt(attemptWithOperationId)) {
          if (operationId)
            void captureClientOperationFailure({
              operation: 'order.create',
              phase: 'retry_storage',
              correlationId: operationId,
            });
          throw new OrderAttemptStorageError();
        }
        const { data } = attemptWithOperationId.order
          ? { data: { order: attemptWithOperationId.order } }
          : await api.post('/orders', orderPayload, {
              headers: {
                'Idempotency-Key': attemptWithOperationId.idempotencyKey,
                ...operationHeaders(operationId),
              },
            });
        const confirmedAttempt = { ...attemptWithOperationId, order: data.order as Order };
        if (!attemptWithOperationId.order && !savePostpaidAttempt(confirmedAttempt)) {
          console.error('The confirmed order could not be copied into retry storage');
          postpaidAttemptRef.current = confirmedAttempt;
          if (operationId)
            void captureClientOperationFailure({
              operation: 'order.create',
              phase: 'retry_state_update',
              correlationId: operationId,
            });
        }
        toast.success(t('orderPlaced', { number: data.order.order_number }));
        orderForKot = data.order as Order;
        if (!clearPostpaidAttempt()) {
          if (operationId)
            void captureClientOperationFailure({
              operation: 'order.create',
              phase: 'retry_cleanup',
              correlationId: operationId,
            });
          reportOrderFailure({
            code: 'order.retry_state.cleanup_failed',
            title: t('orderPlaced', { number: data.order.order_number }),
            message: t('saleCompleteCleanupFailed'),
            nextStep: t('saleCompleteCheckOrders'),
            detail: 'The order was created but local retry state could not be cleared',
            status: null,
            operation: 'order.create',
            stage: 'cleanup',
            outcome: 'applied',
            reasonCode: 'order.retry_state.cleanup_failed',
            correlationId: operationId,
          });
        }
      }

      if (cart.tableId) {
        try {
          const deleted = await heldOrders.removeHeldOrder(
            cart.tableId,
            cart.heldOrderId || undefined,
          );
          if (!deleted) await heldOrders.fetchHeldOrders();
        } catch (heldOrderError) {
          // The order has already been placed. Do not turn a cleanup failure
          // into a failed sale or leave an unhandled promise in the console.
          console.error('Failed to clear held order after placing order', heldOrderError);
          if (
            !(heldOrderError as { response?: unknown } | null)?.response &&
            failureCorrelationId
          ) {
            void captureClientOperationFailure({
              operation: 'order.create',
              phase: 'held_cleanup',
              correlationId: failureCorrelationId,
            });
          }
          reportOrderFailure({
            code: 'order.held_state.cleanup_failed',
            title: t('orderPlaced', { number: orderForKot.order_number }),
            message: t('saleCompleteCleanupFailed'),
            nextStep: t('saleCompleteCheckOrders'),
            detail: 'The order was created but its held-order record could not be refreshed',
            status: null,
            operation: 'order.create',
            stage: 'cleanup',
            outcome: 'applied',
            reasonCode: 'order.held_state.cleanup_failed',
            correlationId: failureCorrelationId,
            operationFailure:
              !(heldOrderError as { response?: unknown } | null)?.response && !!failureCorrelationId
                ? {
                    capture_point: 'fc.frontend.pos.order.create.held_cleanup',
                    operation_id: failureCorrelationId,
                    outcome: 'applied',
                  }
                : undefined,
          });
        }
      }
      cart.clearCart();
      setMobileCartOpen(false);
      await refreshTables();

      await printKotIfEnabled(orderForKot);

      // Success only (errors land in the catch): the waiter works from the
      // table map, so a placed order — new or add-items — returns them to
      // it immediately. Other roles stay on the POS. Skipped when this
      // submit raised a support dialog (e.g. a cleanup failure on a placed
      // order) so the dialog is never unmounted unseen.
      if (isServerRole && supportErrorCountRef.current === supportErrorsAtStart) {
        router.replace('/tables');
        return;
      }
    } catch (error) {
      if (error instanceof OrderAttemptStorageError)
        reportOrderStorageFailure(
          t('placeOrderFailed'),
          failureOperation === 'order.append' ? 'order.append' : 'order.create',
          failureCorrelationId,
        );
      else
        reportOrderRequestFailure(
          error,
          t('placeOrderFailed'),
          failureOperation,
          failureStage,
          failureCorrelationId,
        );
    } finally {
      setSubmitting(false);
    }
  };

  // Handle prepaid checkout - place order and pay in one step
  const handlePrepaidCheckout = async (
    payments: PrepaidPayment[],
    walletAmount: number,
    discount: PrepaidDiscount | null,
  ) => {
    const isPrepaidCheckout = shouldTakePaymentNow;
    setShowPrepaidCheckout(false);
    setSubmitting(true);
    const orderItems = cart.items.map(cartItemToOrderItem);
    let paymentLines = payments
      .filter((p) => p.amount > 0)
      .map((p) => ({
        method: p.method,
        ...(p.payment_method_id !== undefined ? { payment_method_id: p.payment_method_id } : {}),
        amount: p.amount,
        ...(p.transaction_id !== undefined ? { transaction_id: p.transaction_id } : {}),
      }));
    if (walletAmount > 0) paymentLines.push({ method: 'wallet', amount: walletAmount });
    const paymentCustomerId: string | number | null = cart.customerId ?? null;
    let paymentFingerprint = JSON.stringify({
      payments: paymentLines,
      customer_id: paymentCustomerId,
    });
    const cartFingerprint = buildCurrentCartFingerprint(orderItems);
    let storedAttempt: PrepaidAttempt | null;
    try {
      storedAttempt = readPrepaidAttempt();
    } catch (error) {
      // An unreadable attempt cannot be safely replaced with a fresh key.
      if (!(error instanceof OrderAttemptStorageError)) throw error;
      reportOrderStorageFailure(t('processOrderFailed'));
      setSubmitting(false);
      return;
    }
    const existingAttempt =
      storedAttempt &&
      storedAttempt.userId === activeUserId &&
      storedAttempt.cartFingerprint === cartFingerprint &&
      storedAttempt.orderIdempotencyKey &&
      storedAttempt.paymentIdempotencyKey
        ? storedAttempt
        : null;
    const savedPaymentRequest =
      existingAttempt?.bill && existingAttempt.paymentFingerprint
        ? parsePrepaidPaymentRequest(existingAttempt.paymentFingerprint)
        : null;
    if (existingAttempt?.bill && existingAttempt.paymentFingerprint && !savedPaymentRequest) {
      reportOrderFailure({
        code: 'request.outcome_unknown',
        title: t('processOrderFailed'),
        message: t('operationOutcomeUnknown'),
        nextStep: t('operationCheckBeforeRetry'),
        detail:
          'The saved payment request could not be validated, so no replacement payment was submitted',
        status: null,
        operation: 'payment.create',
        stage: 'recovery',
        outcome: 'unknown',
        reasonCode: 'request.outcome_unknown',
        correlationId: existingAttempt.operationId,
      });
      setSubmitting(false);
      return;
    }
    if (savedPaymentRequest && existingAttempt) {
      paymentLines = savedPaymentRequest.payments;
      paymentFingerprint = existingAttempt.paymentFingerprint;
    }
    if (existingAttempt?.bill) {
      const recoveryOperationId = existingAttempt.operationId || createOperationReference();
      try {
        const { data } = await api.get(`/bills/${existingAttempt.bill.id}`, {
          headers: operationHeaders(recoveryOperationId),
        });
        if (!data?.bill || !['paid', 'partial', 'unpaid'].includes(data.bill.payment_status)) {
          throw new Error('Bill status unavailable');
        }
      } catch (recoveryError) {
        if (!(recoveryError as { response?: unknown } | null)?.response && recoveryOperationId) {
          void captureClientOperationFailure({
            operation: 'payment.create',
            phase: 'recovery',
            correlationId: recoveryOperationId,
          });
        }
        reportOrderFailure({
          code: 'request.outcome_unknown',
          title: t('processOrderFailed'),
          message: t('operationOutcomeUnknown'),
          nextStep: t('operationCheckBeforeRetry'),
          detail: 'The bill status could not be confirmed before retrying payment',
          status: null,
          operation: 'payment.create',
          stage: 'recovery',
          outcome: 'unknown',
          reasonCode: 'request.outcome_unknown',
          correlationId: recoveryOperationId,
        });
        setSubmitting(false);
        return;
      }
    }
    const currentDiscount = savedPaymentRequest
      ? existingAttempt?.discount || null
      : discount && discount.value > 0
        ? discount
        : null;
    const discountFingerprint = (value: PrepaidDiscount | null | undefined) =>
      JSON.stringify(value ? { type: value.type, value: value.value, reason: value.reason } : null);
    const discountChanged =
      !!existingAttempt &&
      !savedPaymentRequest &&
      discountFingerprint(existingAttempt.discount) !== discountFingerprint(currentDiscount);
    const retryDiscount = currentDiscount;
    let attempt: PrepaidAttempt = existingAttempt
      ? {
          ...existingAttempt,
          discount: retryDiscount,
          bill: discountChanged ? undefined : existingAttempt.bill,
          paymentFingerprint,
          paymentIdempotencyKey:
            savedPaymentRequest ||
            (existingAttempt.paymentFingerprint === paymentFingerprint && !discountChanged)
              ? existingAttempt.paymentIdempotencyKey
              : newIdempotencyKey(),
        }
      : {
          userId: activeUserId || '',
          cartFingerprint,
          paymentFingerprint,
          discount: discount && discount.value > 0 ? discount : null,
          orderIdempotencyKey: newIdempotencyKey(),
          paymentIdempotencyKey: newIdempotencyKey(),
          operationId: createOperationReference() || undefined,
        };
    const operationId = attempt.operationId || createOperationReference();
    if (operationId && attempt.operationId !== operationId) attempt = { ...attempt, operationId };
    // Persist the keys before the first order mutation. The server replays the
    // order response if this renderer loses the response or restarts.
    if (!savePrepaidAttempt(attempt)) {
      reportOrderStorageFailure(t('processOrderFailed'), 'order.create', operationId || null);
      setSubmitting(false);
      return;
    }
    let orderData: { order: Order } | null = null;
    let billData: { bill: Bill } | null = null;
    let failureOperation = 'order.create';
    let failureStage = 'submission';
    let failureCorrelationId: string | null = null;
    let committedOrder: Order | null = attempt.order || null;
    try {
      failureCorrelationId = operationId;
      if (operationId && attempt.operationId !== operationId) {
        attempt = { ...attempt, operationId };
        requirePrepaidAttemptSaved(attempt);
      }
      if (attempt.order) {
        orderData = { order: attempt.order };
      } else {
        failureOperation = 'order.create';
        failureStage = 'submission';
        const { data } = await api.post(
          '/orders',
          {
            table_id: cart.tableId,
            customer_id: cart.customerId,
            type: cart.orderType,
            guest_count: cart.guestCount,
            special_instructions: cart.orderNotes || undefined,
            online_platform:
              cart.orderType === 'online' ? cart.onlinePlatform || undefined : undefined,
            external_order_id:
              cart.orderType === 'online' ? cart.externalOrderId || undefined : undefined,
            delivery_address:
              cart.orderType === 'delivery' ? cart.deliveryAddress || undefined : undefined,
            expected_payment_method:
              cart.orderType === 'delivery' ? cart.expectedPaymentMethod || undefined : undefined,
            expected_payment_method_id:
              cart.orderType === 'delivery'
                ? (cart.expectedPaymentMethodId ?? undefined)
                : undefined,
            delivery_note:
              cart.orderType === 'delivery' ? cart.deliveryNote || undefined : undefined,
            waived_charge_ids: Array.from(cart.waivedChargeIds),
            opted_in_charge_ids: Array.from(cart.optedInChargeIds),
            items: orderItems,
          },
          {
            headers: {
              'Idempotency-Key': attempt.orderIdempotencyKey,
              ...operationHeaders(operationId),
            },
          },
        );
        orderData = data;
        committedOrder = data.order as Order;
        requirePrepaidAttemptSaved({ ...attempt, order: data.order });
      }
      if (!orderData) throw new Error('Order result unavailable');
      const order = orderData.order;
      const orderId = order.id;

      // Apply discount before bill generation so bill totals reflect discounted net amounts.
      const effectiveDiscount = attempt.discount;
      const discountForRequest =
        effectiveDiscount &&
        currentDiscount &&
        discountFingerprint(effectiveDiscount) === discountFingerprint(currentDiscount)
          ? {
              ...effectiveDiscount,
              override_pin: currentDiscount.override_pin,
              approver_id: currentDiscount.approver_id,
            }
          : effectiveDiscount;
      let discountAlreadyApplied = false;
      if (
        !attempt.bill &&
        (discountChanged || (effectiveDiscount && effectiveDiscount.value > 0)) &&
        attempt.order
      ) {
        try {
          const { data: currentOrderData } = await api.get(`/orders/${orderId}`, {
            headers: operationHeaders(operationId),
          });
          const serverDiscount =
            currentOrderData.order?.discount_type &&
            Number(currentOrderData.order.discount_value) > 0
              ? {
                  type: currentOrderData.order.discount_type,
                  value: Number(currentOrderData.order.discount_value),
                  reason: currentOrderData.order.discount_reason || undefined,
                }
              : null;
          discountAlreadyApplied =
            discountFingerprint(serverDiscount) === discountFingerprint(effectiveDiscount);
        } catch {
          // If the order cannot be read, retain the safe retry behavior below;
          // an approval PIN may be required to reapply an uncertain discount.
        }
      }
      if (
        !attempt.bill &&
        !discountAlreadyApplied &&
        (discountChanged || (effectiveDiscount && effectiveDiscount.value > 0))
      ) {
        failureOperation = 'order.discount';
        failureStage = 'discount';
        await api.patch(
          `/orders/${orderId}/discount`,
          {
            discount_type: discountForRequest?.type || 'percentage',
            discount_value: discountForRequest?.value || 0,
            discount_reason: discountForRequest?.reason,
            override_pin: discountForRequest?.override_pin,
            approver_id: discountForRequest?.approver_id,
          },
          { headers: operationHeaders(operationId) },
        );
      }

      if (attempt.bill) {
        billData = { bill: attempt.bill };
      } else {
        failureOperation = 'bill.generate';
        failureStage = 'bill_generation';
        const { data: generatedBill } = await api.post(
          '/bills/generate',
          { order_id: orderId },
          { headers: operationHeaders(operationId) },
        );
        billData = generatedBill;
      }
      if (!billData) throw new Error('Bill result unavailable');
      const bill = billData.bill;
      const paymentRequest = savedPaymentRequest || {
        payments: paymentLines,
        customer_id: bill.customer_id ?? order.customer_id ?? null,
      };
      const exactPaymentFingerprint = savedPaymentRequest
        ? attempt.paymentFingerprint
        : JSON.stringify(paymentRequest);
      if (attempt.paymentFingerprint !== exactPaymentFingerprint || !attempt.bill) {
        failureOperation = attempt.bill ? 'payment.create' : 'bill.generate';
        failureStage = 'retry_state';
        attempt = { ...attempt, order, bill, paymentFingerprint: exactPaymentFingerprint };
        requirePrepaidAttemptSaved(attempt);
      }

      // Record every split in one atomic request. The persisted bill/key pair
      // makes a lost response safe to retry without creating a second order.
      failureOperation = 'payment.create';
      failureStage = 'payment_submission';
      const paymentResponse = await api.post(`/bills/${bill.id}/payments`, paymentRequest, {
        headers: {
          'Idempotency-Key': attempt.paymentIdempotencyKey,
          ...operationHeaders(operationId),
        },
      });
      const paidBill: Bill = paymentResponse.data?.bill || bill;
      const pointsEarned =
        paymentResponse.data?.loyaltyPointsEarned > 0
          ? paymentResponse.data.loyaltyPointsEarned
          : 0;

      if (paidBill.payment_status !== 'paid') {
        const incompleteMessage = t('paymentIncomplete', {
          amount: currencyFmt(Number(paidBill.balance) || 0),
        });
        savePrepaidAttempt({
          ...attempt,
          bill: paidBill,
          paymentFingerprint: '',
          paymentIdempotencyKey: newIdempotencyKey(),
        });
        reportOrderFailure({
          code: 'payment.incomplete',
          title: incompleteMessage,
          message: incompleteMessage,
          nextStep: t('openOrdersToPay'),
          detail: 'The bill remains partially unpaid after the recorded payment',
          status: null,
          operation: 'payment.create',
          stage: 'completion',
          outcome: 'partial',
          reasonCode: 'payment.incomplete',
          correlationId: operationId,
        });
        return;
      }

      const completedAttempt = { ...attempt, order, bill: paidBill };
      if (!savePrepaidAttempt(completedAttempt)) {
        // Payment is confirmed. Keep that fact in memory and never turn a
        // local retry-state write failure into advice to charge again.
        prepaidAttemptRef.current = stripPrepaidDiscountPin(completedAttempt);
        if (operationId)
          void captureClientOperationFailure({
            operation: 'payment.create',
            phase: 'retry_state_update',
            correlationId: operationId,
          });
        reportOrderFailure({
          code: 'payment.retry_state.persist_failed',
          title: t('orderPaid', { number: order.order_number }),
          message: t('saleCompleteCleanupFailed'),
          nextStep: t('saleCompleteCheckOrders'),
          detail:
            'Payment completed but local retry state could not be updated with the confirmed bill',
          status: null,
          operation: 'payment.create',
          stage: 'cleanup',
          outcome: 'applied',
          reasonCode: 'payment.retry_state.persist_failed',
          correlationId: operationId,
          operationFailure: operationId
            ? {
                capture_point: 'fc.client.payment.create.retry_state_update',
                operation_id: operationId,
                outcome: 'applied',
              }
            : undefined,
        });
      }

      const successMsg =
        pointsEarned > 0
          ? t('orderPaidWithPoints', { number: order.order_number, points: pointsEarned })
          : t('orderPaid', { number: order.order_number });
      toast.success(successMsg);
      if (cart.tableId) {
        try {
          const deleted = await heldOrders.removeHeldOrder(
            cart.tableId,
            cart.heldOrderId || undefined,
          );
          if (!deleted) await heldOrders.fetchHeldOrders();
        } catch (heldOrderError) {
          // The payment is complete; clearing the held-order record is cleanup.
          console.error('Failed to clear held order after payment', heldOrderError);
          if (!(heldOrderError as { response?: unknown } | null)?.response && operationId) {
            void captureClientOperationFailure({
              operation: 'payment.create',
              phase: 'held_cleanup',
              correlationId: operationId,
            });
          }
          reportOrderFailure({
            code: 'order.held_state.cleanup_failed',
            title: t('orderPaid', { number: order.order_number }),
            message: t('saleCompleteCleanupFailed'),
            nextStep: t('saleCompleteCheckOrders'),
            detail: 'Payment completed but its held-order record could not be refreshed',
            status: null,
            operation: 'payment.create',
            stage: 'cleanup',
            outcome: 'applied',
            reasonCode: 'order.held_state.cleanup_failed',
            correlationId: operationId,
            operationFailure:
              !(heldOrderError as { response?: unknown } | null)?.response && !!operationId
                ? {
                    capture_point: 'fc.frontend.pos.payment.create.held_cleanup',
                    operation_id: operationId,
                    outcome: 'applied',
                  }
                : undefined,
          });
        }
      }
      cart.clearCart();
      if (!clearPrepaidAttempt()) {
        if (operationId)
          void captureClientOperationFailure({
            operation: 'payment.create',
            phase: 'retry_cleanup',
            correlationId: operationId,
          });
        reportOrderFailure({
          code: 'payment.retry_state.cleanup_failed',
          title: t('orderPaid', { number: order.order_number }),
          message: t('saleCompleteCleanupFailed'),
          nextStep: t('saleCompleteCheckOrders'),
          detail: 'Payment completed but local retry state could not be cleared',
          status: null,
          operation: 'payment.create',
          stage: 'cleanup',
          outcome: 'applied',
          reasonCode: 'payment.retry_state.cleanup_failed',
          correlationId: operationId,
        });
      }
      setMobileCartOpen(false);
      await refreshTables();

      await printKotIfEnabled(order);

      await printBillForTenant(paidBill, isPrepaidCheckout);
    } catch (error) {
      if (error instanceof OrderAttemptStorageError && committedOrder) {
        if (
          failureOperation === 'payment.create' &&
          failureStage === 'retry_state' &&
          failureCorrelationId
        ) {
          void captureClientOperationFailure({
            operation: 'payment.create',
            phase: 'retry_storage',
            correlationId: failureCorrelationId,
          });
        }
        if (
          failureOperation === 'bill.generate' &&
          failureStage === 'retry_state' &&
          failureCorrelationId
        ) {
          void captureClientOperationFailure({
            operation: 'bill.generate',
            phase: 'retry_state_update',
            correlationId: failureCorrelationId,
          });
        }
        if (failureOperation === 'order.create' && failureCorrelationId) {
          void captureClientOperationFailure({
            operation: 'order.create',
            phase: 'retry_state_update',
            correlationId: failureCorrelationId,
          });
        }
        cart.clearCart();
        setMobileCartOpen(false);
        // Keep the durable pre-order key: replaying it after reload returns the
        // already-created order without creating another one.
        reportOrderFailure({
          code: 'order.retry_state.persist_failed',
          title: t('orderPlaced', { number: committedOrder.order_number }),
          message: t('orderCreatedPaymentNotStarted'),
          nextStep: t('openOrdersToPay'),
          detail:
            failureOperation === 'bill.generate'
              ? 'The bill was generated, but local payment retry state could not be saved before payment'
              : 'Order was created, but local checkout recovery state could not be saved before payment',
          status: null,
          operation: failureOperation === 'bill.generate' ? 'bill.generate' : 'order.create',
          stage: failureOperation === 'bill.generate' ? 'retry_state' : failureStage,
          outcome: 'applied',
          reasonCode:
            failureOperation === 'bill.generate'
              ? 'bill.retry_state.persist_failed'
              : 'order.retry_state.persist_failed',
          correlationId: failureCorrelationId,
          operationFailure:
            failureOperation === 'bill.generate' && failureCorrelationId
              ? {
                  capture_point: 'fc.client.bill.generate.retry_state_update',
                  operation_id: failureCorrelationId,
                  outcome: 'applied',
                }
              : undefined,
        });
      } else if (error instanceof OrderAttemptStorageError)
        reportOrderStorageFailure(
          t('processOrderFailed'),
          failureOperation === 'payment.create' ? 'payment.create' : 'order.create',
          failureCorrelationId,
        );
      else {
        if (failureOperation === 'payment.create' && attempt.bill) {
          const failure = classifyOrderRequestFailure(error, {
            operation: 'payment.create',
            correlationId: failureCorrelationId || '',
          });
          if (
            failure.trusted &&
            failure.outcome === 'not_applied' &&
            failure.displayCode !== 'idempotency_conflict'
          ) {
            savePrepaidAttempt({
              ...attempt,
              paymentFingerprint: '',
              paymentIdempotencyKey: newIdempotencyKey(),
            });
          }
        }
        reportOrderRequestFailure(
          error,
          t('processOrderFailed'),
          failureOperation,
          failureStage,
          failureCorrelationId,
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Add cart items directly to existing order
  const handleAddCartToOrder = async (table: Table, order: Order) => {
    if (cart.items.length === 0) {
      toast.error(t('cartEmpty'));
      return;
    }
    setSubmitting(true);
    const operationId = createOperationReference();
    try {
      const items = cart.items.map(cartItemToOrderItem);
      const specialInstructions = order.special_instructions || undefined;
      const fingerprint = buildAppendItemsFingerprint(order.id, items, specialInstructions);
      const storage = getAppendAttemptStorage();
      const itemAttempt = getOrCreateAppendAttempt(storage, {
        userId: activeUserId || '',
        orderId: order.id,
        fingerprint,
        createKey: newIdempotencyKey,
        items,
        specialInstructions,
        orderNumber: order.order_number,
        operationId: operationId || undefined,
      });
      addItemsAttemptRef.current = itemAttempt;
      const { data } = await api.post(
        `/orders/${order.id}/items`,
        {
          items,
          special_instructions: specialInstructions,
        },
        {
          headers: {
            'Idempotency-Key': itemAttempt.idempotencyKey,
            ...operationHeaders(itemAttempt.operationId),
          },
        },
      );
      // A resolved response is the confirmation boundary. Keep the durable
      // attempt through all network errors so a lost response can replay it.
      const cleared = clearAppendAttempt(storage, itemAttempt);
      if (!cleared && itemAttempt.operationId) {
        void captureClientOperationFailure({
          operation: 'order.append',
          phase: 'retry_cleanup',
          correlationId: itemAttempt.operationId,
        });
        reportOrderFailure({
          code: 'order.append.retry_state.cleanup_failed',
          title: t('itemsAddedToOrder', { number: order.order_number }),
          message: t('appendCompleteCleanupFailed'),
          nextStep: t('appendCompleteCheckOrders'),
          detail: 'Items were added to the order but local retry state could not be cleared',
          status: null,
          operation: 'order.append',
          stage: 'cleanup',
          outcome: 'applied',
          reasonCode: 'order.append.retry_state.cleanup_failed',
          correlationId: itemAttempt.operationId,
        });
      }
      addItemsAttemptRef.current = null;
      toast.success(t('itemsAddedToOrder', { number: order.order_number }));
      const updatedOrder = data.order as Order;
      const existingItemIds = new Set((order.items || []).map((item) => Number(item.id)));
      const appendedItems = (updatedOrder.items || []).filter(
        (item) => !existingItemIds.has(Number(item.id)),
      );
      await printKotIfEnabled(
        appendedItems.length > 0 ? { ...updatedOrder, items: appendedItems } : updatedOrder,
      );
      cart.clearCart();
      setCheckoutTable(null);
      refreshTables();
    } catch (error) {
      if (error instanceof OrderAttemptStorageError)
        reportOrderStorageFailure(t('addItemsFailed'), 'order.append', operationId);
      else
        reportOrderRequestFailure(
          error,
          t('addItemsFailed'),
          'order.append',
          'append_items',
          operationId,
        );
    } finally {
      setSubmitting(false);
    }
  };

  const handlePaymentComplete = async () => {
    const bill = paymentBill; // capture before clearing state
    setPaymentBill(null);
    setCheckoutOverridePin(undefined);
    setCheckoutTable(null);
    refreshTables();

    if (bill) {
      try {
        await printBillForTenant(await fetchLatestBill(bill.id));
      } catch {
        toast.error(t('receiptPrintFailed'));
      }
    }
  };

  return {
    supportError,
    setSupportError,
    handlePlaceOrder,
    handlePrepaidCheckout,
    handleAddCartToOrder,
    handlePaymentComplete,
    printBillForTenant,
  };
}
