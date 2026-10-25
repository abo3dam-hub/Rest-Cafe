'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { usePosSettingsStore } from '@/store/pos-settings';
import { getLanguageDirection, isLanguage } from '@/lib/i18n/languages';
import type { Addon, Category, Product, ProductVariant } from '@/lib/types';

interface SelfOrderInfo {
  business_name: string;
  logo: string;
  language: string | null;
  table: { id: string; number: string };
  currency: string;
  currency_symbol: string;
  currency_position: 'prefix' | 'suffix';
  currency_fraction_digits: number;
}

interface CartAddon {
  addon: Addon;
  quantity: number;
}

interface CartLine {
  key: string;
  product: Product;
  variant: ProductVariant | null;
  addons: CartAddon[];
  quantity: number;
  notes: string;
}

function lineUnitPrice(line: CartLine): number {
  const base = line.variant ? line.variant.price : line.product.price;
  return base + line.addons.reduce((sum, a) => sum + a.addon.price * a.quantity, 0);
}

export default function SelfOrderPage() {
  const t = useTranslations('selfOrder');
  const language = usePosSettingsStore((s) => s.language);
  const setLanguage = usePosSettingsStore((s) => s.setLanguage);

  const [token, setToken] = useState<string | null>(null);
  const [info, setInfo] = useState<SelfOrderInfo | null>(null);
  const [fatalError, setFatalError] = useState<'invalid' | 'unavailable' | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [configuring, setConfiguring] = useState<Product | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [orderNotes, setOrderNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<{ orderNumber: string; total: number | null } | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const tParam = new URLSearchParams(window.location.search).get('t');
      if (!tParam) {
        if (!cancelled) setFatalError('invalid');
        return;
      }
      setToken(tParam);
      try {
        const infoRes = await fetch(`/api/self-order/info?t=${encodeURIComponent(tParam)}`, {
          cache: 'no-store',
        });
        if (cancelled) return;
        if (infoRes.status === 401 || infoRes.status === 404) {
          setFatalError('invalid');
          return;
        }
        if (!infoRes.ok) {
          setFatalError('unavailable');
          return;
        }
        const infoData = (await infoRes.json()) as SelfOrderInfo;
        setInfo(infoData);
        if (isLanguage(infoData.language)) setLanguage(infoData.language);
        const [catRes, prodRes] = await Promise.all([
          fetch(`/api/self-order/categories?t=${encodeURIComponent(tParam)}`, {
            cache: 'no-store',
          }),
          fetch(`/api/self-order/products?t=${encodeURIComponent(tParam)}`, { cache: 'no-store' }),
        ]);
        if (cancelled) return;
        if (catRes.ok) {
          const data = await catRes.json();
          setCategories(data.categories || []);
        }
        if (prodRes.ok) {
          const data = await prodRes.json();
          setProducts((data.products || []).filter((p: Product) => p.is_active));
        }
      } catch {
        if (!cancelled) setFatalError('unavailable');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setLanguage]);

  const money = useMemo(() => {
    const frac = info?.currency_fraction_digits ?? 0;
    const symbol = info?.currency_symbol || '';
    const position = info?.currency_position || 'suffix';
    return (amount: number) => {
      const text = amount.toLocaleString('en-US', {
        minimumFractionDigits: frac,
        maximumFractionDigits: frac,
      });
      return position === 'prefix' ? `${symbol} ${text}` : `${text} ${symbol}`;
    };
  }, [info]);

  const visibleProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (activeCategory !== 'all' && p.category_id !== activeCategory) return false;
      if (q && !p.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [products, activeCategory, search]);

  const cartCount = cart.reduce((sum, l) => sum + l.quantity, 0);
  const cartTotal = cart.reduce((sum, l) => sum + lineUnitPrice(l) * l.quantity, 0);

  function addLine(
    product: Product,
    variant: ProductVariant | null,
    addons: CartAddon[],
    notes: string,
  ) {
    const addonKey = addons
      .map((a) => `${a.addon.id}x${a.quantity}`)
      .sort()
      .join(',');
    const key = `${product.id}|${variant?.id || ''}|${addonKey}|${notes}`;
    setCart((current) => {
      const existing = current.find((l) => l.key === key);
      if (existing) {
        return current.map((l) => (l.key === key ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [...current, { key, product, variant, addons, quantity: 1, notes }];
    });
    idempotencyKeyRef.current = null;
  }

  function handleProductTap(product: Product) {
    const hasVariants = (product.variants || []).some((v) => v.is_active);
    const hasGroups = (product.addon_groups || []).some(
      (g) => g.is_active && (g.addons || []).some((a) => a.is_active),
    );
    if (hasVariants || hasGroups) {
      setConfiguring(product);
    } else {
      addLine(product, null, [], '');
    }
  }

  function changeLineQty(key: string, delta: number) {
    setCart((current) =>
      current
        .map((l) => (l.key === key ? { ...l, quantity: l.quantity + delta } : l))
        .filter((l) => l.quantity > 0),
    );
    idempotencyKeyRef.current = null;
  }

  async function confirmOrder() {
    if (!token || cart.length === 0 || submitting) return;
    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `self-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/self-order/orders?t=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKeyRef.current,
        },
        body: JSON.stringify({
          customer_name: customerName.trim() || undefined,
          notes: orderNotes.trim() || undefined,
          items: cart.map((line) => ({
            product_id: line.product.id,
            variant_id: line.variant?.id || null,
            quantity: line.quantity,
            addons:
              line.addons.length > 0
                ? line.addons.map((a) => ({ id: a.addon.id, quantity: a.quantity }))
                : null,
            special_instructions: line.notes || null,
          })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSubmitError(data.error || t('submitFailed'));
        return;
      }
      setPlaced({
        orderNumber: data.order?.order_number || '',
        total: typeof data.order?.total === 'number' ? data.order.total : null,
      });
      setCart([]);
      setCartOpen(false);
      idempotencyKeyRef.current = null;
    } catch {
      setSubmitError(t('submitFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  if (fatalError) {
    return (
      <main className="mx-auto flex min-h-full w-full max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="text-5xl">🍽️</div>
        <p className="text-lg font-semibold text-foreground">
          {fatalError === 'invalid' ? t('invalidQr') : t('unavailable')}
        </p>
        <p className="text-sm text-muted-foreground">{t('askStaff')}</p>
      </main>
    );
  }

  if (!info) {
    return (
      <main className="flex min-h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      </main>
    );
  }

  if (placed) {
    return (
      <main className="mx-auto flex min-h-full w-full max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="text-6xl">✅</div>
        <p className="text-xl font-bold text-foreground">{t('orderPlaced')}</p>
        {placed.orderNumber && (
          <p className="text-base text-muted-foreground">
            {t('orderNumber')}:{' '}
            <span className="font-semibold text-foreground">{placed.orderNumber}</span>
          </p>
        )}
        {placed.total !== null && (
          <p className="text-base text-muted-foreground">
            {t('total')}:{' '}
            <span className="font-semibold text-foreground">{money(placed.total)}</span>
          </p>
        )}
        <p className="text-sm text-muted-foreground">{t('kitchenNote')}</p>
        <button
          onClick={() => setPlaced(null)}
          className="mt-4 rounded-xl bg-brand px-6 py-3 font-semibold text-white"
        >
          {t('newOrder')}
        </button>
      </main>
    );
  }

  const dir = getLanguageDirection(language);

  return (
    <main dir={dir} className="mx-auto flex min-h-full w-full max-w-2xl flex-col">
      <header className="sticky top-0 z-20 border-b border-border bg-card/95 backdrop-blur">
        <div className="flex items-center gap-3 px-4 py-3">
          {info.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={info.logo} alt="" className="h-11 w-11 rounded-full object-cover" />
          ) : null}
          <div className="min-w-0 flex-1">
            <p className="truncate font-bold text-foreground">{info.business_name}</p>
            <p className="text-xs text-muted-foreground">
              {t('tableLabel')} {info.table.number}
            </p>
          </div>
        </div>
        <div className="px-4 pb-3">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground"
          />
        </div>
        <div className="flex gap-2 overflow-x-auto px-4 pb-3">
          <button
            onClick={() => setActiveCategory('all')}
            className={`whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium ${
              activeCategory === 'all' ? 'bg-brand text-white' : 'bg-muted text-muted-foreground'
            }`}
          >
            {t('allCategories')}
          </button>
          {categories.map((category) => (
            <button
              key={category.id}
              onClick={() => setActiveCategory(category.id)}
              className={`whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium ${
                activeCategory === category.id
                  ? 'bg-brand text-white'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {category.name}
            </button>
          ))}
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3 px-4 py-4 sm:grid-cols-3">
        {visibleProducts.map((product) => (
          <article
            key={product.id}
            className="flex flex-col overflow-hidden rounded-2xl border border-border bg-card"
          >
            {product.has_image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/products/${product.id}/image`}
                alt=""
                className="h-28 w-full object-cover"
                loading="lazy"
              />
            ) : null}
            <div className="flex flex-1 flex-col gap-1 p-3">
              <p className="text-sm font-semibold text-foreground">{product.name}</p>
              {product.description ? (
                <p className="line-clamp-2 text-xs text-muted-foreground">{product.description}</p>
              ) : null}
              <div className="mt-auto flex items-center justify-between pt-2">
                <span className="text-sm font-bold text-foreground">{money(product.price)}</span>
                <button
                  onClick={() => handleProductTap(product)}
                  className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white"
                >
                  {t('add')}
                </button>
              </div>
            </div>
          </article>
        ))}
        {visibleProducts.length === 0 && (
          <p className="col-span-full py-10 text-center text-sm text-muted-foreground">
            {t('emptyMenu')}
          </p>
        )}
      </section>

      {cartCount > 0 && !cartOpen && (
        <button
          onClick={() => setCartOpen(true)}
          className="fixed inset-x-4 bottom-4 z-30 mx-auto flex w-full max-w-2xl items-center justify-between rounded-2xl bg-brand px-5 py-4 font-semibold text-white shadow-lg"
        >
          <span>
            {t('viewCart')} • {cartCount}
          </span>
          <span>{money(cartTotal)}</span>
        </button>
      )}

      {cartOpen && (
        <div className="fixed inset-0 z-40 flex flex-col bg-background">
          <header className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="font-bold text-foreground">{t('yourCart')}</p>
            <button
              onClick={() => setCartOpen(false)}
              className="rounded-lg bg-muted px-3 py-1.5 text-sm font-medium text-foreground"
            >
              {t('backToMenu')}
            </button>
          </header>
          <div className="flex-1 overflow-y-auto px-4 py-3">
            {cart.map((line) => (
              <div key={line.key} className="mb-3 rounded-xl border border-border bg-card p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-foreground">{line.product.name}</p>
                    {line.variant && (
                      <p className="text-xs text-muted-foreground">{line.variant.name}</p>
                    )}
                    {line.addons.map((a) => (
                      <p key={a.addon.id} className="text-xs text-muted-foreground">
                        + {a.addon.name}
                        {a.quantity > 1 ? ` ×${a.quantity}` : ''}
                      </p>
                    ))}
                    {line.notes && (
                      <p className="text-xs italic text-muted-foreground">{line.notes}</p>
                    )}
                  </div>
                  <span className="text-sm font-bold text-foreground">
                    {money(lineUnitPrice(line) * line.quantity)}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <button
                    onClick={() => changeLineQty(line.key, -1)}
                    className="h-8 w-8 rounded-lg bg-muted text-lg font-bold text-foreground"
                  >
                    −
                  </button>
                  <span className="min-w-6 text-center font-semibold text-foreground">
                    {line.quantity}
                  </span>
                  <button
                    onClick={() => changeLineQty(line.key, 1)}
                    className="h-8 w-8 rounded-lg bg-muted text-lg font-bold text-foreground"
                  >
                    +
                  </button>
                </div>
              </div>
            ))}
            {cart.length === 0 && (
              <p className="py-10 text-center text-sm text-muted-foreground">{t('emptyCart')}</p>
            )}
            <div className="mt-4 space-y-3">
              <input
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder={t('customerNamePlaceholder')}
                className="w-full rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-foreground"
              />
              <textarea
                value={orderNotes}
                onChange={(e) => setOrderNotes(e.target.value)}
                placeholder={t('notesPlaceholder')}
                rows={2}
                className="w-full rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-foreground"
              />
            </div>
          </div>
          <footer className="border-t border-border px-4 py-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{t('total')}</span>
              <span className="text-lg font-bold text-foreground">{money(cartTotal)}</span>
            </div>
            {submitError && <p className="mb-2 text-sm text-red-600">{submitError}</p>}
            <button
              onClick={confirmOrder}
              disabled={cart.length === 0 || submitting}
              className="w-full rounded-xl bg-brand py-3.5 font-semibold text-white disabled:opacity-50"
            >
              {submitting ? t('placing') : t('confirmOrder')}
            </button>
            <p className="mt-2 text-center text-xs text-muted-foreground">{t('payAtCounter')}</p>
          </footer>
        </div>
      )}

      {configuring && (
        <ProductSheet
          product={configuring}
          money={money}
          onClose={() => setConfiguring(null)}
          onAdd={(variant, addons, notes) => {
            addLine(configuring, variant, addons, notes);
            setConfiguring(null);
          }}
        />
      )}
    </main>
  );
}

function ProductSheet({
  product,
  money,
  onClose,
  onAdd,
}: {
  product: Product;
  money: (amount: number) => string;
  onClose: () => void;
  onAdd: (variant: ProductVariant | null, addons: CartAddon[], notes: string) => void;
}) {
  const t = useTranslations('selfOrder');
  const variants = (product.variants || []).filter((v) => v.is_active);
  const groups = (product.addon_groups || []).filter(
    (g) => g.is_active && (g.addons || []).some((a) => a.is_active),
  );
  const [variantId, setVariantId] = useState<string>(variants[0]?.id || '');
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  function toggleAddon(groupId: string, addon: Addon, maxSelection: number) {
    setSelected((current) => {
      const next = { ...current };
      if (next[addon.id]) {
        delete next[addon.id];
        return next;
      }
      const inGroup = groups
        .find((g) => g.id === groupId)
        ?.addons?.filter((a) => next[a.id]).length;
      if (maxSelection > 0 && (inGroup || 0) >= maxSelection) return current;
      next[addon.id] = 1;
      return next;
    });
  }

  function handleAdd() {
    for (const group of groups) {
      const count = (group.addons || []).filter((a) => selected[a.id]).length;
      const min = group.is_required
        ? Math.max(1, group.min_selection || 0)
        : group.min_selection || 0;
      if (count < min) {
        setError(`${t('requiredChoice')}: ${group.name}`);
        return;
      }
    }
    const variant = variants.find((v) => v.id === variantId) || null;
    const addons: CartAddon[] = [];
    for (const group of groups) {
      for (const addon of group.addons || []) {
        if (selected[addon.id]) addons.push({ addon, quantity: selected[addon.id] });
      }
    }
    onAdd(variant, addons, notes.trim());
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/50" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl bg-background p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-lg font-bold text-foreground">{product.name}</p>
        {product.description && (
          <p className="mt-1 text-sm text-muted-foreground">{product.description}</p>
        )}

        {variants.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-sm font-semibold text-foreground">{t('chooseVariant')}</p>
            <div className="flex flex-wrap gap-2">
              {variants.map((variant) => (
                <button
                  key={variant.id}
                  onClick={() => setVariantId(variant.id)}
                  className={`rounded-full px-3 py-2 text-sm font-medium ${
                    variantId === variant.id
                      ? 'bg-brand text-white'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {variant.name} • {money(variant.price)}
                </button>
              ))}
            </div>
          </div>
        )}

        {groups.map((group) => (
          <div key={group.id} className="mt-4">
            <p className="mb-2 text-sm font-semibold text-foreground">
              {group.name}
              {group.is_required ? <span className="text-red-600"> *</span> : null}
            </p>
            <div className="flex flex-wrap gap-2">
              {(group.addons || [])
                .filter((a) => a.is_active)
                .map((addon) => (
                  <button
                    key={addon.id}
                    onClick={() => toggleAddon(group.id, addon, group.max_selection)}
                    className={`rounded-full px-3 py-2 text-sm font-medium ${
                      selected[addon.id] ? 'bg-brand text-white' : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {addon.name}
                    {addon.price > 0 ? ` • ${money(addon.price)}` : ''}
                  </button>
                ))}
            </div>
          </div>
        ))}

        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t('itemNotesPlaceholder')}
          rows={2}
          className="mt-4 w-full rounded-xl border border-border bg-card px-3 py-2.5 text-sm text-foreground"
        />
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-4 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 rounded-xl bg-muted py-3 font-semibold text-foreground"
          >
            {t('cancel')}
          </button>
          <button
            onClick={handleAdd}
            className="flex-1 rounded-xl bg-brand py-3 font-semibold text-white"
          >
            {t('add')}
          </button>
        </div>
      </div>
    </div>
  );
}
