import 'express-session';

declare module 'express-session' {
  interface SessionData {
    views?: number;
    id?: string;
  }
}
