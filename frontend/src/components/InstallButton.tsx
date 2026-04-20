import { useEffect, useState } from 'react';
import { Button } from './ui/Button';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

export function InstallButton() {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    function onBip(e: Event) {
      e.preventDefault();
      setPrompt(e as BeforeInstallPromptEvent);
    }
    window.addEventListener('beforeinstallprompt', onBip);
    return () => window.removeEventListener('beforeinstallprompt', onBip);
  }, []);

  if (!prompt) return null;

  return (
    <Button
      variant="secondary"
      onClick={async () => {
        try {
          await prompt.prompt();
          const result = await prompt.userChoice;
          if (result.outcome === 'accepted') setPrompt(null);
        } catch {
          // user cancelled or something else
        }
      }}
    >
      Install app
    </Button>
  );
}
