'use client';

import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { useAuthStore } from '@/store/auth';
import { useCartStore } from '@/store/cart';
import { usePosSettingsStore } from '@/store/pos-settings';
import { useBarcodeScanner } from '@/hooks/useBarcodeScanner';
import { resolveScannedProduct } from '@/lib/scale-barcode';
import { productNeedsCustomizer, scannedVariantNeedsCustomizer } from '@/lib/product-variants';
import type { Dispatch, SetStateAction } from 'react';
import type { Addon, CartItem, Order, Product, ProductVariant } from '@/lib/types';

export interface UsePosProductActionsOptions {
  products: Product[];
  editingCartItem: CartItem | null;
  pendingOrder: Order | null;
  setAddonProduct: Dispatch<SetStateAction<Product | null>>;
  setAddonInitialQuantity: Dispatch<SetStateAction<number>>;
  setAddonInitialVariant: Dispatch<SetStateAction<ProductVariant | null>>;
  setShowCustomerPrompt: Dispatch<SetStateAction<boolean>>;
  setShowTablePicker: Dispatch<SetStateAction<boolean>>;
  scannerEnabled: boolean;
}

export interface UsePosProductActionsResult {
  handleProductClick: (product: Product, quantity?: number) => void;
  handleScannedVariant: (product: Product, variant: ProductVariant, quantity?: number) => void;
  handleAddonAdd: (
    product: Product,
    quantity: number,
    addons: Addon[],
    instructions: string,
    variant: ProductVariant | null,
  ) => void;
  handleEditItemSave: (
    _product: Product,
    quantity: number,
    addons: Addon[],
    instructions: string,
    variant: ProductVariant | null,
  ) => void;
  validateOrderPreflight: () => boolean;
}

/** POS product/cart actions, order preflight and barcode scan, moved from the POS page without behavior change. */
export function usePosProductActions({
  products,
  editingCartItem,
  pendingOrder,
  setAddonProduct,
  setAddonInitialQuantity,
  setAddonInitialVariant,
  setShowCustomerPrompt,
  setShowTablePicker,
  scannerEnabled,
}: UsePosProductActionsOptions): UsePosProductActionsResult {
  const { currentTenant } = useAuthStore();
  const isRestaurant = (currentTenant?.business_type ?? 'restaurant') === 'restaurant';
  const cart = useCartStore();
  const { customerMandatory } = usePosSettingsStore();
  const t = useTranslations('pos');
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

  useBarcodeScanner((code) => {
    const scan = resolveScannedProduct(code, products);
    if (scan) {
      if (scan.scaleBarcode) cart.addItem(scan.product, scan.quantity);
      else if (scan.variant) handleScannedVariant(scan.product, scan.variant);
      else handleProductClick(scan.product);
    } else {
      toast.error(t('barcodeNotFound', { code }));
    }
  }, scannerEnabled);

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

  return {
    handleProductClick,
    handleScannedVariant,
    handleAddonAdd,
    handleEditItemSave,
    validateOrderPreflight,
  };
}
