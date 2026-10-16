import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import './customer.css';

export const metadata: Metadata = {
  title: 'Batch & Batter | Cookie Co.',
  icons: { icon: '/brand/favicon-light.ico' },
  description:
    'Current and upcoming cookie Drops, availability and pickup information.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
