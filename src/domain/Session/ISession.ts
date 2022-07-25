import { SessionData } from 'express-session';
export interface ISession {
  expiredAt: number;
  id: string;
  destroyedAt?: Date;
  json: SessionData;
}
