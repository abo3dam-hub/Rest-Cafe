'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api, { isTransientRequestError } from '@/lib/api';
import { useHeldOrdersStore } from '@/store/held-orders';
import { usePosSettingsStore } from '@/store/pos-settings';
import type { Category, Product, Table } from '@/lib/types';

export interface UsePosCatalogOptions {
  isRestaurant: boolean;
}

/** Catalog load retries, mirroring the KDS enabled-check: 12 tries, 5 s apart. */
export const POS_CATALOG_RETRY_ATTEMPTS = 12;
export const POS_CATALOG_RETRY_DELAY_MS = 5000;

export interface UsePosCatalogResult {
  categories: Category[];
  products: Product[];
  tables: Table[];
  selectedCategory: string | null;
  setSelectedCategory: Dispatch<SetStateAction<string | null>>;
  search: string;
  setSearch: Dispatch<SetStateAction<string>>;
  refreshTables: () => Promise<void>;
  soldOutProducts: Product[];
  showSoldOutModal: boolean;
  setShowSoldOutModal: Dispatch<SetStateAction<boolean>>;
  handleToggleSoldOut: (product: Product) => Promise<void>;
  handleReactivateAllSoldOut: () => Promise<void>;
  /** True while a failed catalog load is being retried with backoff. */
  catalogRetrying: boolean;
}

/** POS catalog data, table refresh and sold-out state, moved from the POS page without behavior change. */
export function usePosCatalog({ isRestaurant }: UsePosCatalogOptions): UsePosCatalogResult {
  const { setBillingType, setTablesRequired, setKotPrintingEnabled } = usePosSettingsStore();
  const heldOrders = useHeldOrdersStore();
  const t = useTranslations('pos');
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showSoldOutModal, setShowSoldOutModal] = useState(false);
  const [catalogRetrying, setCatalogRetrying] = useState(false);
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
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    // Retry transient failures the way the KDS enabled-check does (12 tries,
    // 5 s apart) so a backend still starting or a late Wi-Fi join cannot
    // strand the cashier on an empty grid. A definitive answer (4xx) fails
    // fast instead of retrying a request that cannot succeed.
    const loadOnce = async () => {
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
    };
    const run = async () => {
      try {
        await loadOnce();
        if (!cancelled) setCatalogRetrying(false);
      } catch (error) {
        if (cancelled) return;
        if (isTransientRequestError(error) && attempts < POS_CATALOG_RETRY_ATTEMPTS) {
          attempts += 1;
          setCatalogRetrying(true);
          retryTimer = setTimeout(() => void run(), POS_CATALOG_RETRY_DELAY_MS);
          return;
        }
        setCatalogRetrying(false);
        toast.error(t('menuLoadFailed'));
      }
    };
    void run();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [isRestaurant, setBillingType, setTablesRequired, setKotPrintingEnabled]);

  return {
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
    catalogRetrying,
  };
}
