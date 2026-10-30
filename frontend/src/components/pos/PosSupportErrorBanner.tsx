'use client';

import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { AI_HELP_PROVIDERS, copyPrinterDiagnostic } from '@/lib/printer/ai-help';
import type { PosOrderSubmissionSupportError } from '@/hooks/usePosOrderSubmission';

interface PosSupportErrorBannerProps {
  supportError: PosOrderSubmissionSupportError;
  onDismiss: () => void;
}

/** Support-error banner, moved from the POS page without behavior change. */
export default function PosSupportErrorBanner({
  supportError,
  onDismiss,
}: PosSupportErrorBannerProps) {
  const tSupport = useTranslations('support');
  return (
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
          <button className="rounded border px-3 py-2 text-sm" onClick={onDismiss}>
            {tSupport('dismiss')}
          </button>
        </div>
      </>
    </div>
  );
}
