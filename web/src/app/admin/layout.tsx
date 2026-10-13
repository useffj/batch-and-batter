import type { ReactNode } from 'react';
import './admin.css';
export const metadata = {
  title: 'Administration | Batch & Batter',
  robots: { index: false, follow: false },
};
export default function AdminLayout({ children }: { children: ReactNode }) {
  return children;
}
