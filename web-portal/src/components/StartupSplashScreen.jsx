import { Loader2 } from 'lucide-react';
import { BrandMark } from './auth/AuthLayout';

// Shown while App restores the saved session. Tailwind classes only (no
// <style> tag) — Tauri's CSP nonce blocks inline <style> the app authors.
export default function StartupSplashScreen({ status = 'Restoring session…' }) {
  return (
    <main className="holo-viewport min-h-screen flex flex-col items-center justify-center gap-6 font-ui">
      <BrandMark tagline={null} />
      <p role="status" className="flex items-center gap-2 text-ui-sm text-specter-text-subtle">
        <Loader2 size={14} aria-hidden="true" className="animate-spin text-specter-primary-neon" />
        {status}
      </p>
    </main>
  );
}
