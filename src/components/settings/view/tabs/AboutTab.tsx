import { ExternalLink, MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useVersionCheck } from '../../../../hooks/useVersionCheck';

export default function AboutTab() {
  const { t } = useTranslation('settings');
  const { updateAvailable, latestVersion, currentVersion } = useVersionCheck('siteboon', 'claudecodeui');

  return (
    <div className="space-y-6">
      {/* Logo + name + version */}
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-primary/90 shadow-sm">
          <MessageSquare className="h-5 w-5 text-primary-foreground" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold text-foreground">AutoClaudeCLI</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              v{currentVersion}
            </span>
            {updateAvailable && latestVersion && (
              <span className="flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] font-medium text-green-600 dark:text-green-400">
                {t('apiKeys.version.updateAvailable', { version: latestVersion })}
                <ExternalLink className="h-2.5 w-2.5" />
              </span>
            )}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            AI coding assistant interface
          </p>
        </div>
      </div>
    </div>
  );
}
