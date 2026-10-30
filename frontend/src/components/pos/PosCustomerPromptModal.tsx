'use client';

import { X } from 'lucide-react';
import { useTranslations } from 'use-intl';
import CustomerSearch from '@/components/pos/CustomerSearch';

interface PosCustomerPromptModalProps {
  onClose: () => void;
  onModalOpenChange: (open: boolean) => void;
}

/** Mandatory-customer prompt, moved from the POS page without behavior change. */
export default function PosCustomerPromptModal({
  onClose,
  onModalOpenChange,
}: PosCustomerPromptModalProps) {
  const t = useTranslations('pos');
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-2xl p-5 w-full max-w-sm">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-bold">{t('selectCustomer')}</h3>
          <button
            onClick={onClose}
            className="touch-target rounded-full text-gray-400 hover:text-muted-foreground active:bg-muted"
            aria-label={t('close')}
          >
            <X size={20} />
          </button>
        </div>
        <p className="text-sm text-muted-foreground mb-4">{t('customerRequiredBeforeOrder')}</p>
        <CustomerSearch onSelected={onClose} onModalOpenChange={onModalOpenChange} />
      </div>
    </div>
  );
}
