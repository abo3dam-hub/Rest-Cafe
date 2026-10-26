'use client';

import { useState, useEffect } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { Button } from '@/components/ui/button';

import toast from 'react-hot-toast';
import {
  Plus,
  Search,
  X,
  Edit,
  TrendingUp,
  TrendingDown,
  AlertCircle,
} from 'lucide-react';
import { useSearchParams, useRouter } from 'next/navigation';

import type { Customer } from '@/lib/types';
import { countryName } from '@/lib/countries';
import { dialCodeFor, normalizeOptionalPhone } from '@/lib/phone';
import { useTranslations } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useFormatDate } from '@/hooks/useFormatDate';

function SortIcon({
  field,
  sortField,
  sortOrder,
}: {
  field: string;
  sortField: string;
  sortOrder: 'asc' | 'desc';
}) {
  if (sortField !== field)
    return (
      <span className="text-gray-300 w-3 inline-block ms-1 opacity-0 group-hover:opacity-100 transition-opacity">
        ↕
      </span>
    );
  return sortOrder === 'asc' ? (
    <TrendingUp size={12} className="inline ms-1 text-muted-foreground" />
  ) : (
    <TrendingDown size={12} className="inline ms-1 text-muted-foreground" />
  );
}

export default function CustomersPage() {
  const { currentTenant } = useAuthStore();
  const tCustomer = useTranslations('customer');
  const tCustomers = useTranslations('customers');
  const tOrders = useTranslations('orders');
  const tPos = useTranslations('pos');
  const tNav = useTranslations('nav');
  const tCommon = useTranslations('common');
  const fmt = useFormatCurrency();
  const { formatDate } = useFormatDate();
  const defaultCountry = currentTenant?.country || '';
  const dialCode = dialCodeFor(defaultCountry);
  const searchParams = useSearchParams();
  const router = useRouter();
  const filter = searchParams.get('filter');

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState('name');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [showForm, setShowForm] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);

  const [form, setForm] = useState({
    name: '',
    phone: '',
    email: '',
    address: '',
    notes: '',
    country_code: dialCode,
  });

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const params: Record<string, string> = {};
      if (search) params.search = search;
      if (filter) params.filter = filter;
      if (sortField) params.sort = sortField;
      if (sortOrder) params.order = sortOrder;
      api
        .get('/customers', { params, signal: controller.signal })
        .then(({ data }) => setCustomers(data.data || []))
        .catch((err: unknown) => {
          if (
            !(err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError'))
          )
            toast.error(tCustomer('loadFailed'));
        })
        .finally(() => {
          setLoading(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filter, sortField, sortOrder, refreshKey]);

  const openAdd = () => {
    setEditingCustomer(null);

    setForm({
      name: '',
      phone: '',
      email: '',
      address: '',
      notes: '',
      country_code: dialCode,
    });
    setShowForm(true);
  };

  const openEdit = (c: Customer) => {
    setEditingCustomer(c);

    setForm({
      name: c.name,
      phone: c.phone || '',
      email: c.email || '',
      address: c.address || '',
      notes: c.notes || '',
      country_code: c.country_code || dialCode,
    });
    setShowForm(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const norm = normalizeOptionalPhone(form.phone, defaultCountry);
    if (!norm.valid) {
      toast.error(tPos('invalidPhone', { country: countryName(defaultCountry) }));
      return;
    }
    if (!editingCustomer && !norm.e164) {
      toast.error(tPos('invalidPhone', { country: countryName(defaultCountry) }));
      return;
    }
    const { address, ...restForm } = form;
    const includeAddress = !editingCustomer || address !== (editingCustomer.address || '');
    const payload = {
      ...restForm,
      ...(includeAddress ? { address } : {}),
      phone: norm.e164 ?? '',
      country_code: norm.countryCode ?? '',
    };
    try {
      if (editingCustomer) {
        await api.put(`/customers/${editingCustomer.id}`, payload);
        toast.success(tCustomer('updated'));
      } else {
        await api.post('/customers', payload);
        toast.success(tCustomer('added'));
      }
      setShowForm(false);
      setRefreshKey((k) => k + 1);
    } catch (err: unknown) {
      const serverMessage =
        typeof err === 'object' && err !== null && 'response' in err
          ? (err as { response?: { data?: { message?: string; error?: string } } }).response?.data
              ?.message ||
            (err as { response?: { data?: { message?: string; error?: string } } }).response?.data
              ?.error
          : undefined;
      toast.error(serverMessage || tCustomer('saveFailed'));
    }
  };

  const onSort = (field: string) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder(field === 'name' ? 'asc' : 'desc');
    }
  };

  return (
    <div className="dashboard-scroll-shell flex h-full min-h-0 flex-col">
      <div className="mb-6 flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <h1 className="text-2xl font-bold text-foreground">{tNav('customers')}</h1>
          {filter === 'invalid_phones' && (
            <span className="bg-red-100 text-red-800 text-xs px-2.5 py-1 rounded-full font-medium flex items-center gap-1.5">
              <AlertCircle size={14} /> {tCustomers('actionRequired')}
              <button
                onClick={() => router.push('/customers')}
                aria-label={tCommon('clear')}
                className="ms-1 text-red-500 hover:text-red-700"
              >
                <X size={12} />
              </button>
            </span>
          )}
        </div>
        <Button onClick={openAdd}>
          <Plus size={16} className="me-1" /> {tCustomer('add')}
        </Button>
      </div>

      <div className="relative mb-4 shrink-0">
        <Search size={18} className="absolute start-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={tCustomer('search')}
          className="w-full ps-10 pe-4 py-2.5 bg-card border border-border rounded-lg focus:ring-2 focus:ring-brand outline-none"
        />
      </div>

      <div
        data-testid="customers-list-scroll"
        className="bg-card rounded-xl border border-border flex-1 min-h-0 overflow-x-hidden overflow-y-auto"
      >
        <table className="w-full">
          <thead className="bg-muted">
            <tr>
              <th
                className="text-start p-4 text-xs font-medium text-muted-foreground uppercase cursor-pointer hover:bg-muted group transition-colors"
                onClick={() => onSort('name')}
              >
                {tCustomers('columnCustomer')}{' '}
                <SortIcon field="name" sortField={sortField} sortOrder={sortOrder} />
              </th>
              <th
                className="text-start p-4 text-xs font-medium text-muted-foreground uppercase cursor-pointer hover:bg-muted group transition-colors"
                onClick={() => onSort('phone')}
              >
                {tCustomer('phone')}{' '}
                <SortIcon field="phone" sortField={sortField} sortOrder={sortOrder} />
              </th>
              <th
                className="text-center p-4 text-xs font-medium text-muted-foreground uppercase cursor-pointer hover:bg-muted group transition-colors"
                onClick={() => onSort('last_visit')}
              >
                {tCustomers('columnLastVisit')}{' '}
                <SortIcon field="last_visit" sortField={sortField} sortOrder={sortOrder} />
              </th>
              <th
                className="text-center p-4 text-xs font-medium text-muted-foreground uppercase cursor-pointer hover:bg-muted group transition-colors"
                onClick={() => onSort('visits')}
              >
                {tCustomer('visits')}{' '}
                <SortIcon field="visits" sortField={sortField} sortOrder={sortOrder} />
              </th>
              <th
                className="text-end p-4 text-xs font-medium text-muted-foreground uppercase cursor-pointer hover:bg-muted group transition-colors"
                onClick={() => onSort('spent')}
              >
                {tCustomer('totalSpent')}{' '}
                <SortIcon field="spent" sortField={sortField} sortOrder={sortOrder} />
              </th>
              <th className="text-center p-4 text-xs font-medium text-muted-foreground uppercase">
                {tCustomers('columnActions')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {customers.map((c) => (
              <tr key={c.id} className="hover:bg-muted">
                <td className="p-4">
                  <p className="font-medium text-foreground">{c.name}</p>
                  <p className="text-xs text-muted-foreground">{c.email || '—'}</p>
                </td>
                <td className="p-4 text-sm text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <span>
                      <Ltr>
                        {c.phone
                          ? c.country_code && !c.phone.startsWith(c.country_code)
                            ? `${c.country_code}${c.phone}`
                            : c.phone
                          : '—'}
                      </Ltr>
                    </span>
                    {c.phone && !c.phone.startsWith('+') && (
                      <div className="text-red-500 flex items-center" title="Invalid format">
                        <AlertCircle size={16} />
                      </div>
                    )}
                  </div>
                </td>
                <td className="p-4 text-center text-sm text-muted-foreground whitespace-nowrap">
                  {c.last_visit_at ? formatDate(c.last_visit_at) : '—'}
                </td>
                <td className="p-4 text-center text-sm">{c.visits_count}</td>
                <td className="p-4 text-end font-medium">{fmt(Number(c.total_spent))}</td>
                <td className="p-4 text-center">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openEdit(c)}
                    aria-label={tCommon('edit')}
                    title={tCommon('edit')}
                  >
                    <Edit size={14} />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {customers.length === 0 && (
          <p className="text-center text-muted-foreground py-12">{tCustomers('empty')}</p>
        )}
        {customers.length >= 200 && (
          <p className="text-center text-xs text-gray-400 py-3">{tCustomers('first200')}</p>
        )}
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-2xl p-6 w-full max-w-sm max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold">
                {editingCustomer ? tCustomer('edit') : tCustomer('add')}
              </h2>
              <button onClick={() => setShowForm(false)} aria-label={tCommon('close')}>
                <X size={20} className="text-gray-400" />
              </button>
            </div>
            <form onSubmit={handleSave} className="space-y-4">
              <input
                type="text"
                placeholder={tCustomer('name')}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                required
              />
              <div className="flex items-stretch gap-2">
                <input
                  type="tel"
                  placeholder={dialCode ? `${dialCode} ${tCustomer('phone')}` : tCustomer('phone')}
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  className="flex-1 px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand"
                  required={!editingCustomer}
                />
              </div>
              <input
                type="email"
                placeholder={`${tCustomer('email')} (${tCommon('optional')})`}
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand"
              />
              <input
                type="text"
                name="address"
                aria-label={tPos('customerAddress')}
                placeholder={`${tPos('customerAddress')} (${tCommon('optional')})`}
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand"
              />
              <textarea
                name="notes"
                aria-label={tOrders('notesOptional')}
                placeholder={tOrders('notesOptional')}
                maxLength={500}
                rows={2}
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg outline-none focus:ring-2 focus:ring-brand resize-none"
              />
              <Button type="submit" className="w-full">
                {editingCustomer ? tCustomer('update') : tCustomer('add')}
              </Button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
