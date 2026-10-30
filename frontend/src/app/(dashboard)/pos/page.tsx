'use client';

import { useState } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { useCartStore } from '@/store/cart';
import { useHeldOrdersStore } from '@/store/held-orders';
import { usePosSettingsStore } from '@/store/pos-settings';
import { useSidebar } from '@/components/ui/sidebar';
import toast from 'react-hot-toast';
import { Bell, BellOff } from 'lucide-react';
import type { Product, ProductVariant, Table, Bill, Order, CartItem } from '@/lib/types';
import { useConfirm } from '@/hooks/use-confirm';

import ProductGrid from '@/components/pos/ProductGrid';
import CartPanel from '@/components/pos/CartPanel';
import AddonModal from '@/components/pos/AddonModal';
import TablePickerModal from '@/components/pos/TablePickerModal';
import TableCheckoutModal from '@/components/pos/TableCheckoutModal';
import PaymentModal from '@/components/pos/PaymentModal';
import PrepaidCheckoutModal from '@/components/pos/PrepaidCheckoutModal';
import PosTopbar from '@/components/pos/PosTopbar';
import PosSupportErrorBanner from '@/components/pos/PosSupportErrorBanner';
import PosWorkspaceBanner from '@/components/pos/PosWorkspaceBanner';
import PosTableRail from '@/components/pos/PosTableRail';
import PosMobileCartDrawer from '@/components/pos/PosMobileCartDrawer';
import PosCustomerPromptModal from '@/components/pos/PosCustomerPromptModal';
import PosOrderAlertBanners from '@/components/pos/PosOrderAlertBanners';
import PosSoldOutModal from '@/components/pos/PosSoldOutModal';
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
import { usePosKeyboardShortcuts } from '@/hooks/usePosKeyboardShortcuts';
import { usePosOrderSubmission } from '@/hooks/usePosOrderSubmission';
import { usePosTableWorkspace } from '@/hooks/usePosTableWorkspace';
import { usePosCatalog } from '@/hooks/usePosCatalog';
import { usePosFullscreen } from '@/hooks/usePosFullscreen';
import { usePosOrderAlert } from '@/hooks/usePosOrderAlert';
import { usePosProductActions } from '@/hooks/usePosProductActions';
import { usePosTableActions } from '@/hooks/usePosTableActions';
import KeyboardShortcutsModal from '@/components/pos/KeyboardShortcutsModal';
import { dispatchQuickSearchRequest } from '@/lib/quick-search';
import { useTranslations } from 'use-intl';
import { getCurrencySymbol, getCountryByCode } from '@/lib/countries';
import { fractionalQuantityStep, roundToQuantityPrecision } from '@/lib/utils';
import type { PrepaidAttempt } from '@/lib/pos/order-attempts';

// Loaded on demand: the menu printer pulls the thermal print kernel in, which the
// POS has no use for until the merchant opens the dialog.
const PrintMenuModal = dynamic(() => import('@/components/products/PrintMenuModal'), {
  ssr: false,
});

export default function POSPage() {
  const { currentTenant } = useAuthStore();
  const isRestaurant = (currentTenant?.business_type ?? 'restaurant') === 'restaurant';
  const cart = useCartStore();
  const heldOrders = useHeldOrdersStore();
  const { billingType, gridDensity, setGridDensity } = usePosSettingsStore();
  const { open: leftSidebarOpen } = useSidebar();
  const t = useTranslations('pos');
  const tCommon = useTranslations('common');
  const tKds = useTranslations('kds');
  const { confirm, ConfirmDialog, isConfirmOpen } = useConfirm();
  const cashDrawer = useCashDrawerMovements();
  const shift = useCashSession();
  // Shift actions follow the same owner/manager/cashier group as the
  // backend route gates (backend still enforces; this only hides the entry).
  const canUseShift = tenantCan(currentTenant, 'cash.shifts.view');

  const { categorySort, itemSort } = usePosSortPreference();
  const [submitting, setSubmitting] = useState(false);
  const [mobileCartOpen, setMobileCartOpen] = useState(false);
  const [showPrintMenuModal, setShowPrintMenuModal] = useState(false);
  const {
    categories,
    products,
    tables,
    selectedCategory,
    setSelectedCategory,
    search,
    setSearch,
    refreshTables,
    soldOutProducts,
    showSoldOutModal,
    setShowSoldOutModal,
    handleToggleSoldOut,
    handleReactivateAllSoldOut,
  } = usePosCatalog({ isRestaurant });
  const { orderAlert, showPrimeBanner, handlePrimeBanner } = usePosOrderAlert();

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

  const { fullscreen, toggleFullscreen } = usePosFullscreen();

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

  const {
    handleProductClick,
    handleScannedVariant,
    handleAddonAdd,
    handleEditItemSave,
    validateOrderPreflight,
  } = usePosProductActions({
    products,
    editingCartItem,
    pendingOrder,
    setAddonProduct,
    setAddonInitialQuantity,
    setAddonInitialVariant,
    setShowCustomerPrompt,
    setShowTablePicker,
    scannerEnabled: !anyModalOpen,
  });
  const {
    handleSelectAvailableTable,
    handleSelectOccupiedTable,
    handleSelectHeldTable,
    handleHoldTable,
    handleAddItemsToOrder,
  } = usePosTableActions({
    tables,
    refreshTables,
    setShowTablePicker,
    setCheckoutTable,
    setPendingOrder,
    canTakePayments,
    confirm,
  });

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
        <PosSupportErrorBanner
          supportError={supportError}
          onDismiss={() => setSupportError(null)}
        />
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
        <PosWorkspaceBanner
          wsTable={wsTable}
          wsOrder={wsOrder}
          wsParams={wsParams}
          wsBillBusy={wsBillBusy}
          canTakePayments={canTakePayments}
          onRequestBill={handleWsRequestBill}
          onCheckout={() => setCheckoutTable(wsTable)}
        />
      )}

      {/* Main content area */}
      <div className="flex flex-1 min-h-0 overflow-hidden p-4 gap-4">
        {wsParams.table && (
          <PosTableRail tables={tables} wsParams={wsParams} onSelectTable={goWsTable} />
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

      <PosMobileCartDrawer
        open={mobileCartOpen}
        onOpenChange={setMobileCartOpen}
        cartPanelProps={cartPanelProps}
        itemCount={itemCount}
      />

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
        <PosCustomerPromptModal
          onClose={() => setShowCustomerPrompt(false)}
          onModalOpenChange={setPromptCustomerModalOpen}
        />
      )}

      {ConfirmDialog}

      <PosOrderAlertBanners
        showPrimeBanner={showPrimeBanner}
        onPrimeBanner={handlePrimeBanner}
        alert={orderAlert.alert}
        onDismissAlert={orderAlert.dismissAlert}
      />

      {showSoldOutModal && (
        <PosSoldOutModal
          products={soldOutProducts}
          onClose={() => setShowSoldOutModal(false)}
          onToggleSoldOut={handleToggleSoldOut}
          onReactivateAll={handleReactivateAllSoldOut}
        />
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
