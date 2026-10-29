'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { useCartStore } from '@/store/cart';
import { useHeldOrdersStore } from '@/store/held-orders';
import { usePosSettingsStore } from '@/store/pos-settings';
import { useSidebar } from '@/components/ui/sidebar';
import toast from 'react-hot-toast';
import { ShoppingCart, X, Bell, BellOff } from 'lucide-react';
import type {
  Addon,
  Category,
  Product,
  ProductVariant,
  Table,
  Bill,
  Order,
  CartItem,
} from '@/lib/types';
import { useConfirm } from '@/hooks/use-confirm';
import { Drawer, DrawerContent, DrawerTrigger } from '@/components/ui/drawer';

import ProductGrid from '@/components/pos/ProductGrid';
import CartPanel from '@/components/pos/CartPanel';
import AddonModal from '@/components/pos/AddonModal';
import CustomerSearch from '@/components/pos/CustomerSearch';
import TablePickerModal from '@/components/pos/TablePickerModal';
import TableCheckoutModal from '@/components/pos/TableCheckoutModal';
import PaymentModal from '@/components/pos/PaymentModal';
import PrepaidCheckoutModal from '@/components/pos/PrepaidCheckoutModal';
import PosTopbar from '@/components/pos/PosTopbar';
import dynamic from 'next/dynamic';
import { ShiftOpenModal } from '@/components/dashboard/ShiftOpenModal';
import { ShiftCloseModal } from '@/components/dashboard/ShiftCloseModal';
import { useCashSession } from '@/hooks/useCashSession';
import { usePosSortPreference } from '@/hooks/usePosSort';
import { tenantCan } from '@/lib/permissions';
import { CashDrawerMovementModal } from '@/components/dashboard/CashDrawerMovementModal';
import { useCashDrawerMovements } from '@/hooks/useCashDrawerMovements';
import { usePrinterStore } from '@/hooks/usePrinter';
import { printerService } from '@/lib/printer/PrinterService';
import { AI_HELP_PROVIDERS, copyPrinterDiagnostic } from '@/lib/printer/ai-help';
import { useBarcodeScanner } from '@/hooks/useBarcodeScanner';
import { usePosKeyboardShortcuts } from '@/hooks/usePosKeyboardShortcuts';
import { usePosOrderSubmission } from '@/hooks/usePosOrderSubmission';
import { usePosTableWorkspace } from '@/hooks/usePosTableWorkspace';
import KeyboardShortcutsModal from '@/components/pos/KeyboardShortcutsModal';
import { dispatchQuickSearchRequest } from '@/lib/quick-search';
import { useTranslations } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useNewOrderAlert, type AlertableOrder } from '@/hooks/useNewOrderAlert';
import { getCurrencySymbol, getCountryByCode } from '@/lib/countries';
import { resolveScannedProduct } from '@/lib/scale-barcode';
import { productNeedsCustomizer, scannedVariantNeedsCustomizer } from '@/lib/product-variants';
import { fractionalQuantityStep, roundToQuantityPrecision } from '@/lib/utils';
import type { PrepaidAttempt } from '@/lib/pos/order-attempts';

// Loaded on demand: the menu printer pulls the thermal print kernel in, which the
// POS has no use for until the merchant opens the dialog.
const PrintMenuModal = dynamic(() => import('@/components/products/PrintMenuModal'), {
  ssr: false,
});

export default function POSPage() {
  const router = useRouter();
  const { currentTenant } = useAuthStore();
  const isRestaurant = (currentTenant?.business_type ?? 'restaurant') === 'restaurant';
  const cart = useCartStore();
  const heldOrders = useHeldOrdersStore();
  const {
    customerMandatory,
    billingType,
    gridDensity,
    setGridDensity,
    setBillingType,
    setTablesRequired,
    setKotPrintingEnabled,
  } = usePosSettingsStore();
  const { open: leftSidebarOpen } = useSidebar();
  const t = useTranslations('pos');
  const tCommon = useTranslations('common');
  const tSupport = useTranslations('support');
  const tTables = useTranslations('tables');
  const tKds = useTranslations('kds');
  const currencyFmt = useFormatCurrency();
  const { confirm, ConfirmDialog, isConfirmOpen } = useConfirm();
  const cashDrawer = useCashDrawerMovements();
  const shift = useCashSession();
  // Shift actions follow the same owner/manager/cashier group as the
  // backend route gates (backend still enforces; this only hides the entry).
  const canUseShift = tenantCan(currentTenant, 'cash.shifts.view');

  const { categorySort, itemSort } = usePosSortPreference();
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [mobileCartOpen, setMobileCartOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [showPrintMenuModal, setShowPrintMenuModal] = useState(false);
  const [showSoldOutModal, setShowSoldOutModal] = useState(false);
  const [alertOrders, setAlertOrders] = useState<AlertableOrder[]>([]);
  // Sold-out («انتهاء الكمية») — manual per-product flag, independent of stock.
  const soldOutProducts = products.filter((p) => p.is_sold_out === true || p.is_sold_out === 1);

  const applySoldOutResponse = useCallback((updated: Product) => {
    setProducts((prev) =>
      prev.map((p) =>
        p.id === updated.id
          ? { ...p, is_sold_out: updated.is_sold_out, sold_out_at: updated.sold_out_at }
          : p,
      ),
    );
  }, []);

  const handleToggleSoldOut = useCallback(
    async (product: Product) => {
      const next = !(product.is_sold_out === true || product.is_sold_out === 1);
      try {
        const res = await api.patch(`/products/${product.id}/sold-out`, { sold_out: next });
        if (res.data?.product) applySoldOutResponse(res.data.product as Product);
        toast.success(t('soldOutSaved'));
      } catch {
        toast.error(t('soldOutSaveFailed'));
      }
    },
    [applySoldOutResponse, t],
  );

  const handleReactivateAllSoldOut = useCallback(async () => {
    try {
      const results = await Promise.all(
        soldOutProducts.map((p) => api.patch(`/products/${p.id}/sold-out`, { sold_out: false })),
      );
      results.forEach((res) => {
        if (res.data?.product) applySoldOutResponse(res.data.product as Product);
      });
      toast.success(t('soldOutSaved'));
      setShowSoldOutModal(false);
    } catch {
      toast.error(t('soldOutSaveFailed'));
    }
  }, [soldOutProducts, applySoldOutResponse, t]);

  // Once per business day, the first POS visit re-surfaces items left sold
  // out so yesterday's «انتهت الكمية» is never silently forgotten.
  const soldOutReminderChecked = useRef(false);
  useEffect(() => {
    if (soldOutReminderChecked.current || products.length === 0) return;
    soldOutReminderChecked.current = true;
    if (soldOutProducts.length === 0) return;
    try {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Damascus' }).format(
        new Date(),
      );
      const key = `restcafe:soldout-reminder:${today}`;
      if (window.localStorage.getItem(key)) return;
      window.localStorage.setItem(key, '1');
      setShowSoldOutModal(true);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products]);

  // New-order sound for the cashier: the POS has no live orders socket, so
  // it polls the same kitchen feed the KDS REST fallback uses.
  const orderAlert = useNewOrderAlert(alertOrders, { surface: 'pos' });
  useEffect(() => {
    if (!orderAlert.enabled) return;
    let cancelled = false;
    const fetchOrders = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const { data } = await api.get('/kitchen/orders?status=pending,preparing,ready,served');
        if (!cancelled) setAlertOrders((data.orders as AlertableOrder[]) || []);
      } catch {}
    };
    fetchOrders();
    const id = setInterval(fetchOrders, 20000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [orderAlert.enabled]);

  const [primeBannerDismissed, setPrimeBannerDismissed] = useState<boolean>(() =>
    typeof window === 'undefined'
      ? true
      : window.localStorage.getItem('flocafe:order-alert:prime-banner-dismissed') === '1',
  );
  const showPrimeBanner = orderAlert.enabled && !orderAlert.primed && !primeBannerDismissed;
  const handlePrimeBanner = () => {
    orderAlert.primeAudio();
    try {
      window.localStorage.setItem('flocafe:order-alert:prime-banner-dismissed', '1');
    } catch {}
    setPrimeBannerDismissed(true);
  };

  // Modal state
  const [showTablePicker, setShowTablePicker] = useState(false);
  const [addonProduct, setAddonProduct] = useState<Product | null>(null);
  const [addonInitialQuantity, setAddonInitialQuantity] = useState(1);
  // The variant a scanned barcode named, preselected in the customizer.
  const [addonInitialVariant, setAddonInitialVariant] = useState<ProductVariant | null>(null);
  const [editingCartItem, setEditingCartItem] = useState<CartItem | null>(null);
  const [checkoutTable, setCheckoutTable] = useState<Table | null>(null);
  const [paymentBill, setPaymentBill] = useState<Bill | null>(null);
  const [checkoutOverridePin, setCheckoutOverridePin] = useState<string | undefined>();
  const [showCustomerPrompt, setShowCustomerPrompt] = useState(false);
  const [topbarCustomerModalOpen, setTopbarCustomerModalOpen] = useState(false);
  const [promptCustomerModalOpen, setPromptCustomerModalOpen] = useState(false);
  const customerModalOpen = topbarCustomerModalOpen || promptCustomerModalOpen;
  const [cartPanelModalOpen, setCartPanelModalOpen] = useState(false);
  const [showPrepaidCheckout, setShowPrepaidCheckout] = useState(false);
  const [prepaidModalAttempt, setPrepaidModalAttempt] = useState<PrepaidAttempt | null>(null);
  const [cardTransactionIdRequired, setCardTransactionIdRequired] = useState(false);
  const [showKeyboardShortcutsModal, setShowKeyboardShortcutsModal] = useState(false);
  const [pendingOrder, setPendingOrder] = useState<Order | null>(null);

  const currency = getCurrencySymbol(
    currentTenant?.currency || '',
    getCountryByCode(currentTenant?.country ?? '')?.locale,
  );
  const billingIsPrepaid = billingType === 'prepaid';
  // Roles without payments.take (e.g. the waiter, who orders for the
  // customer) never enter a payment flow: their orders are placed and
  // settled later by a cashier.
  const canTakePayments = tenantCan(currentTenant, 'payments.take');
  const shouldTakePaymentNow = billingIsPrepaid && canTakePayments;
  // The waiter's home screen is the table map: a successfully placed order
  // returns them straight to it (see the end of handlePlaceOrder).
  const isServerRole = currentTenant?.role === 'server';

  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (window.electronAPI?.getWindowState) {
      window.electronAPI
        .getWindowState()
        .then((state) => {
          if (state && typeof state === 'object' && 'isMaximized' in state) {
            setFullscreen(Boolean(state.isMaximized || state.isFullScreen));
          }
        })
        .catch(() => {});

      if (window.electronAPI.onWindowStateChanged) {
        return window.electronAPI.onWindowStateChanged((state) => {
          setFullscreen(Boolean(state?.isMaximized || state?.isFullScreen));
        });
      }
      return;
    }

    const syncFullscreen = () => setFullscreen(document.fullscreenElement != null);
    syncFullscreen();
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (typeof window === 'undefined') return;

    if (window.electronAPI?.windowAction) {
      try {
        await window.electronAPI.windowAction('toggle-maximize');
      } catch {
        toast.error(t('fullscreenUnavailable'));
      }
      return;
    }

    if (typeof document === 'undefined') return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      toast.error(t('fullscreenUnavailable'));
    }
  }, [t]);

  const refreshTables = async () => {
    if (!isRestaurant) return;
    try {
      const { data } = await api.get('/tables?active=1');
      setTables(data.tables || []);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    const fetchData = async () => {
      try {
        // 1. Fetch business settings first
        const settingsRes = await api.get('/settings/business');
        const d = settingsRes.data;
        setBillingType(d.billing_type === 'prepaid' ? 'prepaid' : 'postpaid');
        const isTablesRequired = typeof d.tables_required === 'boolean' ? d.tables_required : true;
        setTablesRequired(isTablesRequired);

        api
          .get('/settings/kot_printing_enabled')
          .then((res) => setKotPrintingEnabled(res.data.setting?.value !== 'false'))
          .catch(() => {});

        // 2. Fetch other menu data
        const requests: Promise<{ data: Record<string, unknown> }>[] = [
          api.get('/categories?active=1'),
          api.get('/products?active=1'),
        ];

        // Dine-in orders always require a table in this product, so the
        // table list is fetched for every restaurant install — it must not
        // be gated on the legacy tables_required setup flag.
        if (isRestaurant) {
          requests.push(api.get('/tables?active=1'));
        }

        const [catRes, prodRes, tableRes] = await Promise.all(requests);
        setCategories((catRes.data.categories as Category[]) || []);
        setProducts((prodRes.data.products as Product[]) || []);

        if (tableRes) {
          setTables((tableRes.data.tables as Table[]) || []);
        } else {
          setTables([]);
        }

        // 3. Fetch held orders for restaurant installs (they are table-bound)
        if (isRestaurant) {
          await heldOrders.fetchHeldOrders();
        }
      } catch {
        toast.error(t('menuLoadFailed'));
      }
    };
    fetchData();
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [isRestaurant, setBillingType, setTablesRequired, setKotPrintingEnabled]);

  const handleProductClick = (product: Product, quantity = 1) => {
    if (!productNeedsCustomizer(product)) {
      cart.addItem(product, quantity);
      return;
    }
    setAddonInitialQuantity(quantity);
    setAddonInitialVariant(null);
    setAddonProduct(product);
  };

  const handleScannedVariant = (product: Product, variant: ProductVariant, quantity = 1) => {
    if (scannedVariantNeedsCustomizer(product, variant)) {
      setAddonInitialQuantity(quantity);
      setAddonInitialVariant(variant);
      setAddonProduct(product);
      return;
    }
    cart.addItem(product, quantity, [], '', variant);
  };

  const handleAddonAdd = (
    product: Product,
    quantity: number,
    addons: Addon[],
    instructions: string,
    variant: ProductVariant | null,
  ) => {
    cart.addItem(product, quantity, addons, instructions, variant);
  };

  const handleEditItemSave = (
    _product: Product,
    quantity: number,
    addons: Addon[],
    instructions: string,
    variant: ProductVariant | null,
  ) => {
    if (!editingCartItem) return;
    cart.updateItemDetails(editingCartItem.id, quantity, addons, instructions, variant);
  };

  // A modal already open means the scan (if one lands) isn't meant for the
  // product grid — e.g. it could be a barcode field inside that modal.
  const anyOtherModalOpen =
    !!addonProduct ||
    !!editingCartItem ||
    !!checkoutTable ||
    !!paymentBill ||
    showCustomerPrompt ||
    customerModalOpen ||
    cartPanelModalOpen ||
    showPrepaidCheckout ||
    cashDrawer.open ||
    shift.openModalOpen ||
    shift.closeModalOpen ||
    showPrintMenuModal ||
    showKeyboardShortcutsModal ||
    isConfirmOpen;
  const anyModalOpen = showTablePicker || anyOtherModalOpen;

  useBarcodeScanner((code) => {
    const scan = resolveScannedProduct(code, products);
    if (scan) {
      if (scan.scaleBarcode) cart.addItem(scan.product, scan.quantity);
      else if (scan.variant) handleScannedVariant(scan.product, scan.variant);
      else handleProductClick(scan.product);
    } else {
      toast.error(t('barcodeNotFound', { code }));
    }
  }, !anyModalOpen);

  const validateOrderPreflight = () => {
    if (cart.items.length === 0) {
      toast.error(t('cartEmpty'));
      return false;
    }
    if (customerMandatory && !cart.customerId) {
      setShowCustomerPrompt(true);
      return false;
    }
    // Append mode needs no cart table: the submit target is the bound
    // existing order (pendingOrder), whose own table is the binding.
    if (isRestaurant && cart.orderType === 'dine_in' && !cart.tableId && !pendingOrder) {
      toast.error(t('selectTableFirst'));
      setShowTablePicker(true);
      return false;
    }
    return true;
  };

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

  const { wsParams, wsTable, wsOrder, wsBillBusy, handleWsRequestBill, goWsTable } =
    usePosTableWorkspace({
      tables,
      refreshTables,
      handleAddItemsToOrder,
    });

  const {
    supportError,
    setSupportError,
    handlePlaceOrder,
    handlePrepaidCheckout,
    handleAddCartToOrder,
    handlePaymentComplete,
    printBillForTenant,
  } = usePosOrderSubmission({
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
  });

  const cartPanelProps = {
    tables,
    currency,
    submitting,
    onPlaceOrder: handlePlaceOrder,
    onShowTablePicker: () => setShowTablePicker(true),
    onEditItem: setEditingCartItem,
    onModalOpenChange: setCartPanelModalOpen,
    existingOrder: pendingOrder,
  };

  const itemCount = cart.itemCount();

  usePosKeyboardShortcuts(
    {
      onFocusSearch: () => {
        dispatchQuickSearchRequest();
      },
      onTender: () => {
        if (!submitting && cart.items.length > 0) {
          void handlePlaceOrder();
        }
      },
      onToggleTables: () => {
        if (isRestaurant && cart.orderType === 'dine_in') {
          setShowTablePicker((prev) => !prev);
        }
      },
      onOpenCheckout: () => {
        if (
          shouldTakePaymentNow ||
          !canTakePayments ||
          !isRestaurant ||
          cart.orderType !== 'dine_in'
        ) {
          void handlePlaceOrder();
          return;
        }
        if (!validateOrderPreflight()) return;
        if (cart.tableId) {
          const tbl = tables.find((t) => t.id === cart.tableId);
          if (tbl) setCheckoutTable(tbl);
          else setShowTablePicker(true);
        } else {
          setShowTablePicker(true);
        }
      },
      onOpenCashMovement: () => {
        cashDrawer.openModal();
      },
      onFocusCustomer: () => {
        const input = document.querySelector<HTMLInputElement>(
          '[data-testid="pos-customer-search-input"]',
        );
        if (input) {
          input.focus();
          input.select();
          return;
        }
        document
          .querySelector<HTMLButtonElement>('[data-testid="pos-customer-select-btn"]')
          ?.click();
      },
      onHoldOrder: () => {
        if (
          isRestaurant &&
          cart.orderType === 'dine_in' &&
          cart.tableId &&
          cart.items.length > 0 &&
          billingType === 'postpaid'
        ) {
          const tableName = tables.find((t) => t.id === cart.tableId)?.name || cart.tableId;
          heldOrders
            .holdOrder(
              cart.tableId,
              cart.items,
              cart.customerId,
              cart.guestCount,
              cart.orderNotes,
              [...cart.waivedChargeIds],
              [...cart.optedInChargeIds],
            )
            .then(() => {
              cart.clearCart();
              toast.success(t('orderHeldFor', { table: tableName }));
            })
            .catch(() => {
              toast.error(t('holdOrderFailed'));
            });
        }
      },
      onToggleFullscreen: () => {
        toggleFullscreen();
      },
      onDismissModalOrBlur: () => {
        if (showKeyboardShortcutsModal) {
          setShowKeyboardShortcutsModal(false);
          return true;
        }
        if (customerModalOpen || cartPanelModalOpen) {
          return false;
        }
        const activeEl = document.activeElement as HTMLElement | null;
        if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
          activeEl.blur();
          return true;
        }
        if (showTablePicker) {
          setShowTablePicker(false);
          return true;
        }
        if (addonProduct) {
          setAddonProduct(null);
          setAddonInitialVariant(null);
          return true;
        }
        if (editingCartItem) {
          setEditingCartItem(null);
          return true;
        }
        if (showCustomerPrompt) {
          setShowCustomerPrompt(false);
          return true;
        }
        if (showPrepaidCheckout) {
          setShowPrepaidCheckout(false);
          return true;
        }
        if (checkoutTable) {
          setCheckoutTable(null);
          return true;
        }
        if (paymentBill) {
          setPaymentBill(null);
          return true;
        }
        if (cashDrawer.open) {
          cashDrawer.setOpen(false);
          return true;
        }
        if (showPrintMenuModal) {
          setShowPrintMenuModal(false);
          return true;
        }
        if (mobileCartOpen) {
          setMobileCartOpen(false);
          return true;
        }
        return false;
      },
      onIncrementLastItem: () => {
        const items = useCartStore.getState().items;
        if (items.length === 0) return;
        const last = items[items.length - 1];
        const step = fractionalQuantityStep(last.product);
        useCartStore
          .getState()
          .updateQuantity(
            last.id,
            step == null ? last.quantity + 1 : roundToQuantityPrecision(last.quantity + step, step),
          );
      },
      onDecrementLastItem: () => {
        const items = useCartStore.getState().items;
        if (items.length === 0) return;
        const last = items[items.length - 1];
        const step = fractionalQuantityStep(last.product);
        useCartStore
          .getState()
          .updateQuantity(
            last.id,
            step == null ? last.quantity - 1 : roundToQuantityPrecision(last.quantity - step, step),
          );
      },
      onClearCart: async () => {
        if (cart.items.length === 0) return;
        const confirmed = await confirm(t('clearAmount') + '?', {
          title: t('cart'),
          confirmLabel: tCommon('clear'),
          destructive: true,
        });
        if (confirmed) cart.clearCart();
      },
      onShowHelp: () => {
        setShowKeyboardShortcutsModal((prev) => !prev);
      },
    },
    {
      enabled: true,
      anyModalOpen,
      tablePickerOpen: showTablePicker && !anyOtherModalOpen,
      cartItemCount: cart.items.length,
    },
  );

  return (
    <>
      {supportError && (
        <div className="fixed bottom-4 start-4 z-50 w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-red-200 bg-card p-4 shadow-xl">
          <>
            <p className="font-semibold text-red-800">{supportError.title}</p>
            <p className="mt-1 text-sm text-muted-foreground">{supportError.message}</p>
            <p className="mt-1 text-sm text-muted-foreground">{supportError.nextStep}</p>
            <details className="mt-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer">{tSupport('showPayload')}</summary>
              <Ltr as="pre" className="mt-2 max-h-32 overflow-auto rounded bg-muted p-2">
                {JSON.stringify(
                  {
                    ...supportError.payload,
                    subject: supportError.subject,
                    correlation_id: supportError.ticketCorrelationId,
                    client_ticket_id: supportError.clientTicketId,
                  },
                  null,
                  2,
                )}
              </Ltr>
            </details>
            <div className="mt-3 flex flex-wrap gap-2">
              {AI_HELP_PROVIDERS.map((provider) => (
                <button
                  key={provider.id}
                  className="rounded border px-3 py-2 text-sm"
                  onClick={() => {
                    window.open(provider.url, '_blank', 'noopener,noreferrer');
                    void (async () => {
                      const diagnosticsMessage =
                        typeof supportError.payload.message === 'string'
                          ? supportError.payload.message
                          : undefined;
                      const copied = await copyPrinterDiagnostic(
                        supportError.message,
                        diagnosticsMessage,
                      );
                      toast(
                        copied
                          ? tSupport('askAiCopied', { provider: provider.label })
                          : tSupport('askAiCopyFailed', { provider: provider.label }),
                        { icon: copied ? '📋' : 'ℹ️' },
                      );
                    })();
                  }}
                >
                  {tSupport('askAi')} · {provider.label}
                </button>
              ))}
              <button
                className="rounded border px-3 py-2 text-sm"
                onClick={() => setSupportError(null)}
              >
                {tSupport('dismiss')}
              </button>
            </div>
          </>
        </div>
      )}
      <PosTopbar
        products={products}
        onTopItemSelect={handleProductClick}
        onShowCashMovement={cashDrawer.openModal}
        // Re-fetch on entry: the mount snapshot can be hours stale on a
        // multi-terminal POS (backend still guards stale operations). On a
        // load failure offer nothing — unknown state is not "no shift".
        onShowShift={async () => {
          const result = await shift.refresh();
          if (result.status !== 'ok') return;
          if (result.error) {
            toast.error(result.error || shift.shiftLoadFailedMessage);
            return;
          }
          if (result.session) shift.setCloseModalOpen(true);
          else shift.setOpenModalOpen(true);
        }}
        shiftHasOpenSession={!!shift.session}
        shiftLoading={shift.loading}
        shiftError={shift.error}
        canUseShift={canUseShift}
        onShowPrintMenu={() => setShowPrintMenuModal(true)}
        fullscreen={fullscreen}
        onToggleFullscreen={toggleFullscreen}
        onCustomerModalOpenChange={setTopbarCustomerModalOpen}
      />

      {wsTable && (
        <div className="mx-4 mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3">
          <span className="text-lg font-extrabold text-foreground">{wsTable.name}</span>
          {wsOrder && (
            <span className="text-sm text-muted-foreground">
              <Ltr>#{wsOrder.order_number}</Ltr> · {tTables('openedFirstOrder')}{' '}
              <Ltr>
                {new Date(wsOrder.created_at).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </Ltr>{' '}
              · <span className="font-bold text-foreground">{currencyFmt(wsOrder.total ?? 0)}</span>
            </span>
          )}
          <div className="ms-auto flex flex-wrap gap-2">
            {wsOrder && (
              <button
                type="button"
                onClick={() =>
                  router.push(
                    `/tables?hall=${encodeURIComponent(wsParams.hall)}&mergeFrom=${wsOrder.id}`,
                  )
                }
                className="h-10 rounded-lg border border-border bg-card px-3.5 text-sm font-bold text-foreground hover:bg-accent"
              >
                {tTables('mergeWith')}
              </button>
            )}
            {wsOrder && wsTable.status !== 'bill_requested' && (
              <button
                type="button"
                onClick={handleWsRequestBill}
                disabled={wsBillBusy}
                className="h-10 rounded-lg border border-amber-600 bg-amber-50 px-3.5 text-sm font-bold text-amber-700 hover:bg-amber-100 disabled:opacity-50 dark:bg-amber-950/40 dark:text-amber-300"
              >
                {tTables('requestBill')}
              </button>
            )}
            {wsOrder && canTakePayments && (
              <button
                type="button"
                onClick={() => setCheckoutTable(wsTable)}
                className="h-10 rounded-lg bg-neutral-900 px-3.5 text-sm font-bold text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900"
              >
                {tCommon('total')} · {currencyFmt(wsOrder.total ?? 0)}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Main content area */}
      <div className="flex flex-1 min-h-0 overflow-hidden p-4 gap-4">
        {wsParams.table && (
          <div className="hidden md:flex md:w-[148px] md:shrink-0 flex-col gap-2 rounded-2xl bg-neutral-800 p-2.5">
            <button
              type="button"
              onClick={() => router.push(`/tables?hall=${encodeURIComponent(wsParams.hall)}`)}
              className="flex h-[52px] items-center justify-center rounded-xl bg-amber-500 text-[15px] font-extrabold text-neutral-900 hover:bg-amber-400"
            >
              {tTables('backToTables')}
            </button>
            <p className="text-center text-[11px] font-medium text-neutral-400">
              {wsParams.hall || tTables('title')}
            </p>
            <div className="grid grid-cols-2 gap-1.5 overflow-y-auto">
              {(tables.filter((tb) => (tb.floor || '') === wsParams.hall).length > 0
                ? tables.filter((tb) => (tb.floor || '') === wsParams.hall)
                : tables
              ).map((tb) => {
                const st = tb.status === 'cleaning' ? 'available' : tb.status;
                const selected = String(tb.id) === wsParams.table;
                return (
                  <button
                    key={tb.id}
                    type="button"
                    onClick={() => goWsTable(tb)}
                    className={`flex h-11 items-center justify-center rounded-lg border-2 text-[13px] font-extrabold ${
                      st === 'occupied'
                        ? 'border-blue-500 bg-blue-950 text-blue-200'
                        : st === 'bill_requested'
                          ? 'border-orange-500 bg-orange-950 text-orange-200'
                          : st === 'reserved'
                            ? 'border-violet-500 bg-violet-950 text-violet-200'
                            : 'border-transparent bg-neutral-700 text-neutral-300'
                    } ${selected ? 'outline outline-2 outline-amber-400' : ''}`}
                  >
                    {tb.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {/* Product Grid — full width on mobile, flex-1 on desktop */}
        <div className="flex-1 min-w-0 h-full flex flex-col">
          <ProductGrid
            categories={categories}
            products={products}
            selectedCategory={selectedCategory}
            setSelectedCategory={setSelectedCategory}
            search={search}
            setSearch={setSearch}
            currency={currency}
            onProductClick={handleProductClick}
            onScannedVariant={handleScannedVariant}
            onScaledProduct={(product, quantity) => cart.addItem(product, quantity)}
            sidebarOpen={leftSidebarOpen}
            categorySort={categorySort}
            itemSort={itemSort}
            collapseCategories
            density={gridDensity}
            onDensityChange={setGridDensity}
            gridClassName={
              gridDensity === 'medium'
                ? leftSidebarOpen
                  ? 'grid-cols-5'
                  : 'grid-cols-6'
                : gridDensity === 'small'
                  ? leftSidebarOpen
                    ? 'grid-cols-6'
                    : 'grid-cols-8'
                  : undefined
            }
            soldOutCount={soldOutProducts.length}
            onOpenSoldOutList={() => setShowSoldOutModal(true)}
            onToggleSoldOut={tenantCan(currentTenant, 'pos.use') ? handleToggleSoldOut : undefined}
            soundControl={
              <button
                type="button"
                onClick={() => orderAlert.setEnabled(!orderAlert.enabled)}
                aria-pressed={orderAlert.enabled}
                title={orderAlert.enabled ? tKds('soundOn') : tKds('soundOff')}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium border bg-card text-foreground border-border hover:bg-muted"
              >
                {orderAlert.enabled ? <Bell size={13} /> : <BellOff size={13} />}
                {orderAlert.enabled ? tKds('soundOn') : tKds('soundOff')}
              </button>
            }
          />
        </div>

        {/* Desktop Cart — always open, hidden on mobile */}
        <div className="hidden md:flex md:w-80 md:shrink-0 h-full">
          <CartPanel {...cartPanelProps} />
        </div>
      </div>

      {/* Mobile: Floating Cart Button + Bottom Sheet — outside flex container */}
      <Drawer open={mobileCartOpen} onOpenChange={setMobileCartOpen}>
        <DrawerTrigger asChild>
          <button
            className="touch-target fixed bottom-5 end-5 z-40 w-14 h-14 bg-brand text-white rounded-full shadow-lg hover:bg-brand-hover active:bg-brand-hover transition-colors md:hidden"
            aria-label={t('cart')}
          >
            <ShoppingCart size={22} />
            {itemCount > 0 && (
              <span className="absolute -top-0.5 -end-0.5 bg-red-500 text-white text-xs w-5 h-5 rounded-full flex items-center justify-center font-bold">
                {itemCount}
              </span>
            )}
          </button>
        </DrawerTrigger>
        <DrawerContent className="max-h-[85vh]">
          <div className="overflow-y-auto max-h-[80vh] px-2 pb-2">
            <CartPanel {...cartPanelProps} variant="drawer" />
          </div>
        </DrawerContent>
      </Drawer>

      {/* Modals */}
      <CashDrawerMovementModal model={cashDrawer} />
      <ShiftOpenModal model={shift} />
      <ShiftCloseModal model={shift} />
      {isRestaurant && showTablePicker && (
        <TablePickerModal
          tables={tables}
          selectedTableId={cart.tableId}
          onSelectAvailable={handleSelectAvailableTable}
          onSelectOccupied={handleSelectOccupiedTable}
          onSelectHeld={handleSelectHeldTable}
          onPlaceOrder={handlePlaceOrder}
          onHoldTable={handleHoldTable}
          onClose={() => setShowTablePicker(false)}
        />
      )}

      {addonProduct && (
        <AddonModal
          product={addonProduct}
          currency={currency}
          initialQuantity={addonInitialQuantity}
          initialVariant={addonInitialVariant}
          onlinePlatformSelected={
            cart.orderType === 'online' && cart.onlinePlatform.trim().length > 0
          }
          onAdd={handleAddonAdd}
          onClose={() => {
            setAddonProduct(null);
            setAddonInitialQuantity(1);
            setAddonInitialVariant(null);
          }}
        />
      )}

      {editingCartItem && (
        <AddonModal
          product={editingCartItem.product}
          currency={currency}
          mode="edit"
          initialQuantity={editingCartItem.quantity}
          initialAddons={editingCartItem.addons}
          initialInstructions={editingCartItem.special_instructions}
          initialVariant={editingCartItem.variant}
          onlinePlatformSelected={
            cart.orderType === 'online' && cart.onlinePlatform.trim().length > 0
          }
          onAdd={handleEditItemSave}
          onClose={() => setEditingCartItem(null)}
        />
      )}

      {checkoutTable && (
        <TableCheckoutModal
          table={checkoutTable}
          tables={tables}
          currency={currency}
          cartItemCount={cart.itemCount()}
          onClose={() => {
            setCheckoutTable(null);
            refreshTables();
          }}
          onAddItems={handleAddItemsToOrder}
          onPrintBill={async (bill, reservedWindow) => {
            await printBillForTenant(bill, true, reservedWindow);
          }}
          reservePrintWindow={() => {
            const printer = usePrinterStore.getState();
            const expectedBrowserPrint =
              printer.printMethod === 'browser' ||
              (printer.printMethod === 'escpos' &&
                !printer.hardwarePrinter &&
                !printerService.isConnected &&
                printer.status !== 'connecting');
            return expectedBrowserPrint ? printerService.reserveBrowserPrintWindow() : undefined;
          }}
          canGenerateBill={tenantCan(currentTenant, 'bills.generate')}
          canReadBills={tenantCan(currentTenant, 'bills.read')}
          onPayment={(bill, overridePin) => {
            setCheckoutTable(null);
            setPaymentBill(bill);
            setCheckoutOverridePin(overridePin);
          }}
          onAddCartToOrder={handleAddCartToOrder}
          onOrderMoved={({ sourceTable, targetTable }) => {
            if (cart.tableId === sourceTable.id) {
              cart.setTableId(targetTable.id);
            }
          }}
        />
      )}

      {paymentBill && (
        <PaymentModal
          key={paymentBill.id}
          bill={paymentBill}
          currency={currency}
          initialOverridePin={checkoutOverridePin}
          onClose={() => {
            setPaymentBill(null);
            setCheckoutOverridePin(undefined);
          }}
          onPaid={handlePaymentComplete}
          onBillUpdate={(updated) => setPaymentBill(updated)}
          onSplit={(departingBill) => {
            if (departingBill) {
              // Clear current paymentBill synchronously so the cashier cannot
              // pay against the remainder source bill during the fetch window.
              setPaymentBill(null);
              setCheckoutOverridePin(undefined);
              void api
                .get(`/bills/${departingBill.id}`)
                .then(({ data }) => setPaymentBill((data?.bill as Bill) ?? departingBill))
                .catch(() => setPaymentBill(departingBill));
            } else {
              setPaymentBill(null);
              setCheckoutOverridePin(undefined);
            }
            refreshTables();
          }}
        />
      )}

      {showCustomerPrompt && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-2xl p-5 w-full max-w-sm">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold">{t('selectCustomer')}</h3>
              <button
                onClick={() => setShowCustomerPrompt(false)}
                className="touch-target rounded-full text-gray-400 hover:text-muted-foreground active:bg-muted"
                aria-label={t('close')}
              >
                <X size={20} />
              </button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">{t('customerRequiredBeforeOrder')}</p>
            <CustomerSearch
              onSelected={() => setShowCustomerPrompt(false)}
              onModalOpenChange={setPromptCustomerModalOpen}
            />
          </div>
        </div>
      )}

      {ConfirmDialog}

      {showPrimeBanner && (
        <button
          type="button"
          onClick={handlePrimeBanner}
          className="fixed bottom-5 inset-x-0 mx-auto w-fit z-40 flex items-center gap-2 rounded-full bg-amber-100 dark:bg-amber-950/80 border border-amber-300 dark:border-amber-800 text-amber-900 dark:text-amber-200 px-4 py-2 text-sm font-medium shadow-lg"
        >
          <Bell size={16} />
          {tKds('enableSoundBanner')}
        </button>
      )}
      {orderAlert.alert && (
        <button
          type="button"
          onClick={orderAlert.dismissAlert}
          className="fixed top-4 inset-x-0 mx-auto w-fit z-50 flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white shadow-lg"
          role="status"
        >
          <Bell size={16} />
          {orderAlert.alert.latestTableLabel
            ? tKds('newOrderAlertTable', { table: orderAlert.alert.latestTableLabel })
            : tKds('newOrderAlert', { count: orderAlert.alert.count })}
        </button>
      )}
      {showSoldOutModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setShowSoldOutModal(false)}
        >
          <div
            className="bg-card rounded-2xl shadow-xl w-full max-w-md max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h2 className="font-bold text-foreground">{t('soldOutReminderTitle')}</h2>
              <button
                type="button"
                onClick={() => setShowSoldOutModal(false)}
                className="text-muted-foreground hover:text-foreground"
                aria-label={tCommon('close')}
              >
                <X size={18} />
              </button>
            </div>
            <div className="overflow-y-auto p-2">
              {soldOutProducts.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg hover:bg-muted/50"
                >
                  <span className="text-sm font-medium text-foreground">{p.name}</span>
                  <button
                    type="button"
                    onClick={() => handleToggleSoldOut(p)}
                    className="shrink-0 rounded-lg bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/50 px-3 py-1 text-xs font-bold"
                  >
                    {t('soldOutRestore')}
                  </button>
                </div>
              ))}
              {soldOutProducts.length === 0 && (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {t('soldOutSaved')}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 p-4 border-t border-border">
              <button
                type="button"
                onClick={handleReactivateAllSoldOut}
                className="flex-1 rounded-lg bg-brand text-white px-4 py-2 text-sm font-bold hover:bg-brand-hover"
              >
                {t('soldOutReactivateAll')}
              </button>
              <button
                type="button"
                onClick={() => setShowSoldOutModal(false)}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                {tCommon('close')}
              </button>
            </div>
          </div>
        </div>
      )}
      <PrintMenuModal open={showPrintMenuModal} onOpenChange={setShowPrintMenuModal} />

      {/* Prepaid Checkout Modal - Payment BEFORE order is placed */}
      {showPrepaidCheckout && (
        <PrepaidCheckoutModal
          currency={currency}
          initialCardTransactionIdRequired={cardTransactionIdRequired}
          initialDiscount={prepaidModalAttempt?.discount ?? null}
          discountCommitted={Boolean(prepaidModalAttempt?.bill)}
          onClose={() => setShowPrepaidCheckout(false)}
          onConfirm={handlePrepaidCheckout}
        />
      )}

      <KeyboardShortcutsModal
        open={showKeyboardShortcutsModal}
        onClose={() => setShowKeyboardShortcutsModal(false)}
      />
    </>
  );
}
