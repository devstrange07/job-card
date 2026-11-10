import type { CatalogCharge, CatalogProduct, Job } from './types'

export const products: CatalogProduct[] = [
  { id: 'p1', name: '20W USB-C Power Adapter', brand: 'Anker', sku: 'ANK-20W-C', unitPriceMinor: 189900 },
  { id: 'p2', name: 'Braided USB-C Cable · 1 m', brand: 'Daily Objects', sku: 'DO-CAB-1M', unitPriceMinor: 79900 },
  { id: 'p3', name: 'Tempered Glass · iPhone 16', brand: 'Spigen', sku: 'SP-IP16-TG', unitPriceMinor: 69900 },
  { id: 'p4', name: 'Clear MagSafe Case · iPhone 16', brand: 'ESR', sku: 'ESR-IP16-M', unitPriceMinor: 149900 },
  { id: 'p5', name: 'Bluetooth Earbuds', brand: 'JBL', sku: 'JBL-WAVE-BEAM', unitPriceMinor: 249900 },
]

export const charges: CatalogCharge[] = [
  { id: 'c1', name: 'Paper bag', amountMinor: 2000 },
  { id: 'c2', name: 'Gift wrapping', amountMinor: 4000 },
]

export const seedJobs: Job[] = [
  {
    id: 'demo-1048', jobNumber: 1048, customerName: 'Priya Mehta', customerPhone: '+919876500981',
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(), timeLabel: '5 min ago', status: 'ready',
    owner: 'Rohan K.', contributors: ['Rohan K.', 'Dev · JBL'],
    lines: [
      { id: '1048-a', label: 'Bluetooth Earbuds', sku: 'JBL-WAVE-BEAM', quantity: 1, unitPriceMinor: 249900, contributor: 'Dev · JBL' },
      { id: '1048-b', label: 'Braided USB-C Cable · 1 m', sku: 'DO-CAB-1M', quantity: 1, unitPriceMinor: 79900, contributor: 'Rohan K.' },
    ],
    charges: [{ id: '1048-c', name: 'Paper bag', quantity: 1, unitAmountMinor: 2000 }],
    payments: [],
  },
  {
    id: 'demo-1047', jobNumber: 1047, customerName: 'Arjun Nair', customerPhone: '+919876500982',
    createdAt: new Date(Date.now() - 13 * 60_000).toISOString(), timeLabel: '13 min ago', status: 'checkout',
    owner: 'Sara M.', contributors: ['Sara M.'],
    lines: [
      { id: '1047-a', label: 'Clear MagSafe Case · iPhone 16', sku: 'ESR-IP16-M', quantity: 1, unitPriceMinor: 149900, contributor: 'Sara M.' },
      { id: '1047-b', label: 'Tempered Glass · iPhone 16', sku: 'SP-IP16-TG', quantity: 1, unitPriceMinor: 69900, contributor: 'Sara M.' },
    ],
    charges: [],
    payments: [{ id: '1047-pay1', method: 'upi', amountMinor: 150000, status: 'pending', time: 'Just now' }],
  },
  {
    id: 'demo-1046', jobNumber: 1046, customerName: 'Meera Kapoor', customerPhone: '+919876500983',
    createdAt: new Date(Date.now() - 22 * 60_000).toISOString(), timeLabel: '22 min ago', status: 'returned',
    owner: 'Rohan K.', contributors: ['Rohan K.'],
    lines: [{ id: '1046-a', label: '20W USB-C Power Adapter', sku: 'ANK-20W-C', quantity: 1, unitPriceMinor: 189900, contributor: 'Rohan K.' }],
    charges: [], note: 'Customer asked for a small discount.', correctionReason: 'Please confirm the quoted adapter price.', payments: [],
  },
  {
    id: 'demo-1045', jobNumber: 1045, customerName: 'Ishaan Shah', customerPhone: '+919876500984',
    createdAt: new Date(Date.now() - 36 * 60_000).toISOString(), timeLabel: '36 min ago', status: 'completed',
    owner: 'Sara M.', contributors: ['Sara M.', 'Dev · JBL'],
    lines: [{ id: '1045-a', label: 'Bluetooth Earbuds', sku: 'JBL-WAVE-BEAM', quantity: 1, unitPriceMinor: 249900, contributor: 'Dev · JBL' }],
    charges: [], invoiceReference: 'INV-58142', finalBilledTotalMinor: 249900,
    payments: [{ id: '1045-pay1', method: 'cash', amountMinor: 100000, status: 'confirmed', time: '10:18 AM' }, { id: '1045-pay2', method: 'upi', amountMinor: 149900, status: 'confirmed', reference: 'UPI · 8391', time: '10:19 AM' }],
  },
]

export const formatMoney = (minor: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(minor / 100)

export const jobQuote = (job: Pick<Job, 'lines' | 'charges'>) =>
  job.lines.reduce((total, line) => total + line.quantity * line.unitPriceMinor, 0) +
  job.charges.reduce((total, charge) => total + charge.quantity * charge.unitAmountMinor, 0)

export const totalConfirmed = (job: Job) =>
  job.payments.filter((payment) => payment.status === 'confirmed').reduce((total, payment) => total + payment.amountMinor, 0)
