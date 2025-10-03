import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'  // Assuming this exists from setup

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'OCL Governance App',
  description: 'Voting and debt ratio tools for OffChain Luxembourg asbl',
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
            <li><a href="/" className="hover:underline">Voting</a></li>
            <li><a href="/debt" className="hover:underline">Debt Ratio</a></li>
          </ul>
        </nav>
        {children}
      </body>
    </html>
  )
}
