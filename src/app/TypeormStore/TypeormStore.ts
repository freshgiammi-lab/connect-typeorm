/*!
 * Connect - TypeORM
 * Copyright(c) 2012 TJ Holowaychuk <tj@vision-media.ca>
 * Copyright(c) 2017, 2018 makepost <makepost@firemail.cc>
 * Copyright(c) 2018 Nathan Phillip Brink <ohnobinki@ohnopublishing.net>
 * Copyright(c) 2022 Gianmarco Rengucci <rengucci.gianmarco@gmail.com>
 * MIT Licensed
 */

import * as Debug from 'debug';
import { SessionData, SessionOptions, Store } from 'express-session';
import { IsNull, Repository } from 'typeorm';
import { ISession } from '../../domain/Session/ISession';

/**
 * One day in seconds.
 */
const oneDay = 86400;

export type Ttl = number | ((store: TypeormStore, sess: SessionData, sid?: string) => number);

export class TypeormStore extends Store {
  private cleanupLimit: number | undefined;
  private debug = Debug('connect:typeorm');
  private limitSubquery = true;
  private onError: ((s: TypeormStore, e: Error) => void) | undefined;
  private repository!: Repository<ISession>;
  private ttl: Ttl | undefined;

  /**
   * Initializes TypeormStore with the given `options`.
   */
  constructor(
    options: Partial<
      SessionOptions & {
        cleanupLimit: number;
        limitSubquery: boolean;
        onError: (s: TypeormStore, e: Error) => void;
        ttl: Ttl;
      }
    > = {}
  ) {
    super();
    this.cleanupLimit = options.cleanupLimit;
    if (options.limitSubquery !== undefined) {
      this.limitSubquery = options.limitSubquery;
    }
    this.onError = options.onError;
    this.ttl = options.ttl;
  }

  public connect(repository: Repository<ISession>) {
    this.repository = repository;
    this.emit('connect');
    return this;
  }

  /**
   * Attempts to fetch session by the given `sid`.
   */
  public get = (sid: string, fn: (error?: Error | undefined, result?: SessionData) => void) => {
    this.debug('GET "%s"', sid);

    this.createQueryBuilder()
      .andWhere('session.id = :id', { id: sid })
      .getOne()
      .then((session) => {
        if (!session) {
          return fn();
        }

        this.debug('GOT %s', session.json);
        const result = session.json;

        fn(undefined, result);
      })
      .catch((er: Error) => {
        fn(er);
        this.handleError(er);
      });
  };

  /**
   * Commits the given `sess` object associated with the given `sid`.
   */
  public set = (sid: string, sess: SessionData, fn?: (error?: Error) => void) => {
    const args = [sid];
    let json: SessionData;

    try {
      json = sess;
    } catch (er: unknown) {
      if (er instanceof Error) {
        return fn ? fn(er) : undefined;
      } else {
        return fn ? fn(new Error('serialize error')) : undefined;
      }
    }

    args.push(JSON.stringify(json));

    const ttl = this.getTTL(sess, sid);
    args.push('EX', ttl.toString());
    this.debug('SET "%s" %s ttl:%s', sid, json, ttl);

    (this.cleanupLimit
      ? (() => {
          const $ = this.repository
            .createQueryBuilder('session')
            .withDeleted()
            .select('session.id')
            .where(`session.expiredAt <= ${Date.now()}`)
            .limit(this.cleanupLimit);
          return this.limitSubquery
            ? Promise.resolve($.getQuery())
            : $.getMany().then((xs) =>
                xs.length
                  ? xs
                      .map((x) =>
                        typeof x.id === 'string' ? `'${x.id.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : `${x.id}`
                      )
                      .join(', ')
                  : 'NULL'
              );
        })().then((ids) => this.repository.createQueryBuilder().delete().where(`id IN (${ids})`).execute())
      : Promise.resolve()
    )
      .then(async () => {
        try {
          // If a session with the given SID is already present (even deleted), renew it.
          // Else, create a new row/session.
          await this.repository.findOneOrFail({ where: { id: sid }, withDeleted: true });
          await this.repository.update(
            {
              destroyedAt: IsNull(),
              id: sid,
            },
            {
              expiredAt: Date.now() + ttl * 1000,
              json,
            }
          );
        } catch (_) {
          await this.repository.insert({
            expiredAt: Date.now() + ttl * 1000,
            id: sid,
            json,
          });
        }
      })
      .then(() => {
        this.debug('SET complete');

        if (fn) {
          fn();
        }
      })
      .catch((er) => {
        if (fn) {
          fn(er);
        }

        this.handleError(er);
      });
  };

  /**
   * Destroys the session associated with the given `sid`.
   */
  public destroy = (sid: string | string[], fn?: (error?: Error) => void) => {
    this.debug('DEL "%s"', sid);

    Promise.all(
      (Array.isArray(sid) ? sid : [sid]).map((x) => {
        this.repository.softDelete({ id: x });
      })
    )
      .then(() => {
        if (fn) {
          fn();
        }
      })
      .catch((er) => {
        if (fn) {
          fn(er);
        }

        this.handleError(er);
      });
  };

  /**
   * Refreshes the time-to-live for the session with the given `sid`.
   */
  public touch = (sid: string, sess: SessionData, fn?: (error?: Error) => void) => {
    const ttl = this.getTTL(sess);

    if (sess?.cookie?.expires) {
      this.debug('Skip updating session "%s" expiration', sid);
      if (fn) {
        fn();
      }
    }

    this.debug('EXPIRE "%s" ttl:%s', sid, ttl);
    this.repository
      .createQueryBuilder()
      .update({ expiredAt: Date.now() + ttl * 1000 })
      .whereInIds([sid])
      .execute()
      .then(() => {
        this.debug('EXPIRE complete');

        if (fn) {
          fn();
        }
      })
      .catch((er) => {
        if (fn) {
          fn(er);
        }

        this.handleError(er);
      });
  };

  /**
   * Fetches all sessions.
   */
  public all = (fn: (error: Error | undefined, result: SessionData[]) => void) => {
    let result: SessionData[] = [];

    this.createQueryBuilder()
      .getMany()
      .then((sessions) => {
        result = sessions.map((session) => {
          const sess = session.json;
          sess.id = session.id;
          return sess;
        });

        fn(undefined, result);
      })
      .catch((er) => {
        fn(er, result);
        this.handleError(er);
      });
  };

  private createQueryBuilder() {
    return this.repository
      .createQueryBuilder('session')
      .where('session.expiredAt > :expiredAt', { expiredAt: Date.now() });
  }

  private getTTL(sess: SessionData, sid?: string) {
    if (typeof this.ttl === 'number') {
      return this.ttl;
    }
    if (typeof this.ttl === 'function') {
      return this.ttl(this, sess, sid);
    }

    const maxAge = sess.cookie.maxAge;
    return typeof maxAge === 'number' ? Math.floor(maxAge / 1000) : oneDay;
  }

  private handleError(er: Error) {
    this.debug('Typeorm returned err', er);
    if (this.onError) {
      this.onError(this, er);
    } else {
      this.emit('disconnect', er);
    }
  }
}
