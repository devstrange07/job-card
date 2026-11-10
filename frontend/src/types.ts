export type JobStatus = 'draft' | 'ready' | 'returned' | 'checkout' | 'completed' | 'cancelled'
export type PaymentMethod = 'cash' | 'upi'
export type PaymentStatus = 'pending' | 'confirmed' | 'reversed'
export type StaffRole = 'salesperson' | 'cashier' | 'manager'

export interface JobLine {
  id: string
  label: string
  sku?: string
  quantity: number
  unitPriceMinor: number
  contributor: string
}

export interface JobCharge {
  id: string
  name: string
  quantity: number
  unitAmountMinor: number
}

export interface Payment {
  id: string
  method: PaymentMethod
  amountMinor: number
  status: PaymentStatus
  reference?: string
  time: string
}

export interface Job {
  id: string
  version?: number
  jobNumber: number
  customerName: string
  customerPhone: string
  createdAt: string
  timeLabel: string
  status: JobStatus
  owner: string
  contributors: string[]
  lines: JobLine[]
  charges: JobCharge[]
  note?: string
  correctionReason?: string
  invoiceReference?: string
  finalBilledTotalMinor?: number
  discrepancyReason?: string
  payments: Payment[]
}

export interface CatalogProduct {
  id: string
  name: string
  brand: string
  sku: string
  unitPriceMinor: number
}

export interface CatalogCharge {
  id: string
  name: string
  amountMinor: number
}
