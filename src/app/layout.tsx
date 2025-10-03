import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import Link from 'next/link';  // Add this import
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'OCL Governance App',
  description: 'Voting and debt ratio tools for OffChain Luxembourg',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <nav className="bg-blue-600 p-4">
          <ul className="flex space-x-4 text-white">
            <li><Link href="/" className="hover:underline">Voting</Link></li>
            <li><Link href="/debt" className="hover:underline">Debt Ratio</Link></li>
          </ul>
        </nav>
        {children}
      </body>
    </html>
  )
}