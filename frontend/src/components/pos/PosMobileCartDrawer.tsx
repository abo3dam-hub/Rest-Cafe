'use client';

import type { ComponentProps } from 'react';
import { ShoppingCart } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { Drawer, DrawerContent, DrawerTrigger } from '@/components/ui/drawer';
import CartPanel from '@/components/pos/CartPanel';

interface PosMobileCartDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cartPanelProps: ComponentProps<typeof CartPanel>;
  itemCount: number;
}

/** Mobile floating cart button and bottom sheet, moved from the POS page without behavior change. */
export default function PosMobileCartDrawer({
  open,
  onOpenChange,
  cartPanelProps,
  itemCount,
}: PosMobileCartDrawerProps) {
  const t = useTranslations('pos');
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
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
  );
}
