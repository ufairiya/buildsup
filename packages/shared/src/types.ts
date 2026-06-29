export type ListingCategory = 'materials' | 'chemicals' | 'services' | 'labour'

export type ListingType = 'availability' | 'requirement'

export interface Listing {
  id: string
  title: string
  description: string
  category: ListingCategory
  type: ListingType
  price?: number
  currency?: string
  location?: string
  userId: string
  createdAt: string
  updatedAt: string
}

export interface User {
  id: string
  email: string
  fullName?: string
  avatarUrl?: string
  createdAt: string
}
