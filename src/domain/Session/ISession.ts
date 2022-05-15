export interface ISession {
  expiredAt: number

  id: string
  created_at: Date
  updated_at: Date
  destroyedAt?: Date
  json: string
}
