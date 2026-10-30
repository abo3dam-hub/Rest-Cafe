'use client';

import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { useCartStore } from '@/store/cart';
import { useHeldOrdersStore } from '@/store/held-orders';
import type { Dispatch, SetStateAction } from 'react';
import type { Order, Table } from '@/lib/types';

export interface UsePosTableActionsOptions {
  tables: Table[];
  refreshTables: () => Promise<void>;
  setShowTablePicker: Dispatch<SetStateAction<boolean>>;
  setCheckoutTable: Dispatch<SetStateAction<Table | null>>;
  setPendingOrder: Dispatch<SetStateAction<Order | null>>;
  canTakePayments: boolean;
  confirm: (
    message: string,
    options?: { title?: string; confirmLabel?: string; destructive?: boolean },
  ) => Promise<boolean>;
}

export interface UsePosTableActionsResult {
  handleSelectAvailableTable: (
    tableId: string,
    customer?: { id: string; name: string; phone: string } | null,
  ) => void;
  handleSelectOccupiedTable: (table: Table) => Promise<void>;
  handleSelectHeldTable: (tableId: string) => Promise<void>;
  handleHoldTable: (tableId: string) => Promise<void>;
  handleAddItemsToOrder: (table: Table, order: Order) => void;
}

/** POS table selection, hold and add-items actions, moved from the POS page without behavior change. */
export function usePosTableActions({
  tables,
  refreshTables,
  setShowTablePicker,
  setCheckoutTable,
  setPendingOrder,
  canTakePayments,
  confirm,
}: UsePosTableActionsOptions): UsePosTableActionsResult {
  const cart = useCartStore();
  const heldOrders = useHeldOrdersStore();
  const t = useTranslations('pos');
  const handleSelectAvailableTable = (
    tableId: string,
    customer?: { id: string; name: string; phone: string } | null,
  ) => {
    const cartCustomerWasInherited = cart.customerSource === 'reservation';

    cart.setTableId(tableId);
    if (customer && (!cart.customerId || cartCustomerWasInherited)) {
      cart.setReservationCustomer({
        ...customer,
        email: null,
        visits_count: 0,
        total_spent: 0,
        last_visit_at: null,
        country_code: '',
      });
    } else if (!customer && cartCustomerWasInherited) {
      cart.setCustomer(null);
    }
    setShowTablePicker(false);
  };

  const handleSelectOccupiedTable = async (table: Table) => {
    const activeOrder = table.current_order || table.activeOrder || null;
    const activeCustomerId = activeOrder?.customer_id;
    const activeCustomerName = activeOrder?.customer?.name || t('anotherCustomer');

    if (
      cart.customerId != null &&
      activeCustomerId != null &&
      String(cart.customerId) !== String(activeCustomerId)
    ) {
      const shouldProceed = await confirm(
        t('customerMismatchWarning', { customer: activeCustomerName }),
        {
          title: t('customerMismatchTitle'),
          confirmLabel: t('proceedAnyway'),
        },
      );

      if (!shouldProceed) return;
    }

    setShowTablePicker(false);
    if (!canTakePayments) {
      // No payment rights (e.g. waiter): an occupied table opens in
      // add-items mode instead of the checkout/payment modal.
      if (activeOrder) {
        try {
          const { data } = await api.get(`/orders/${activeOrder.id}`);
          const fullOrder = (data?.order as Order) ?? (activeOrder as Order);
          handleAddItemsToOrder(table, fullOrder);
        } catch {
          cart.setOrderType('dine_in');
          cart.setTableId(table.id);
        }
      } else {
        cart.setOrderType('dine_in');
        cart.setTableId(table.id);
      }
      return;
    }
    setCheckoutTable(table);
  };

  const handleSelectHeldTable = async (tableId: string) => {
    try {
      const held = await heldOrders.restoreOrder(tableId);
      if (held) {
        // Settle the target type first so the type change cannot clear the saved
        // charge selections that loadItems installs afterwards.
        cart.setOrderType('dine_in');
        cart.loadItems(
          held.items,
          tableId,
          held.customerId,
          held.guestCount,
          held.orderNotes,
          held.id,
          held.waivedChargeIds,
          held.optedInChargeIds,
        );
      } else {
        await heldOrders.fetchHeldOrders();
        toast.error(t('loadOrderFailed'));
      }
    } catch {
      toast.error(t('loadOrderFailed'));
    } finally {
      setShowTablePicker(false);
      await refreshTables();
    }
  };

  const handleHoldTable = async (tableId: string) => {
    if (cart.items.length === 0) {
      toast.error(t('cartEmpty'));
      return;
    }
    const tableName = tables.find((t) => t.id === tableId)?.name || tableId;
    try {
      await heldOrders.holdOrder(
        tableId,
        cart.items,
        cart.customerId,
        cart.guestCount,
        cart.orderNotes,
        [...cart.waivedChargeIds],
        [...cart.optedInChargeIds],
      );
      cart.clearCart();
      setShowTablePicker(false);
      toast.success(t('orderHeld', { tableName }));
      await refreshTables();
    } catch {
      toast.error(t('holdOrderFailed'));
    }
  };

  const handleAddItemsToOrder = (table: Table, order: Order) => {
    setCheckoutTable(null);
    cart.setTableId(table.id);
    cart.setOrderType('dine_in');
    cart.setGuestCount(order.guest_count || 1);
    cart.setOrderNotes(order.special_instructions || '');
    setPendingOrder(order);
    toast(`${t('addingItemsToOrder', { number: order.order_number })} ${t('placeOrderReady')}`, {
      icon: 'ℹ️',
    });
  };

  return {
    handleSelectAvailableTable,
    handleSelectOccupiedTable,
    handleSelectHeldTable,
    handleHoldTable,
    handleAddItemsToOrder,
  };
}
