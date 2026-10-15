import type { ReactNode } from 'react';
import './globals.css';
import './control-polish.css';
import SessionGuard from './session-guard';

export const metadata = {
  title: 'Oxygen Care Reports',
  description: 'Clear, accountable reporting for Oxygen Care.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'),
  openGraph: {
    title: 'Oxygen Care Reports',
    description: 'Clear, accountable reporting for Oxygen Care.',
    images: [{ url: '/og.png', width: 1792, height: 896, alt: 'Oxygen Care Reports' }]
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Oxygen Care Reports',
    description: 'Clear, accountable reporting for Oxygen Care.',
    images: ['/og.png']
  }
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionGuard />
        {children}
      </body>
    </html>
  );
}
