import type { ReactNode } from 'react';
import './globals.css';
import './control-polish.css';
import SessionGuard from './session-guard';

export const metadata = {
  title: 'Irish Hospital Supplies Reports',
  description: 'Clear, accountable reporting for Irish Hospital Supplies.',
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'),
  openGraph: {
    title: 'Irish Hospital Supplies Reports',
    description: 'Clear, accountable reporting for Irish Hospital Supplies.',
    images: [{ url: '/og.png', width: 1792, height: 896, alt: 'Irish Hospital Supplies Reports' }]
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Irish Hospital Supplies Reports',
    description: 'Clear, accountable reporting for Irish Hospital Supplies.',
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
