/*!
 * Connect - TypeORM
 * Copyright(c) 2012 TJ Holowaychuk <tj@vision-media.ca>
 * Copyright(c) 2017, 2018 makepost <makepost@firemail.cc>
 * Copyright(c) 2018 Nathan Phillip Brink <ohnobinki@ohnopublishing.net>
 * MIT Licensed
 */

import * as Debug from "debug";
import { SessionOptions, Store } from "express-session";
import { Repository } from "typeorm";
import { ISession } from "../../domain/Session/ISession";

/**
 * One day in seconds.
 */
const oneDay = 86400;

export type Ttl = number | ((store: TypeormStore, sess: any, sid?: string) => number);

export class TypeormStore extends Store {
  private cleanupLimit: number | undefined;

  private debug = Debug("connect:typeorm");

  private repository!: Repository<ISession>;

  private ttl: Ttl | undefined;

  /**
   * Initializes TypeormStore with the given `options`.
   */
  constructor(options: Partial<SessionOptions & { cleanupLimit: number, ttl: Ttl }> = {}) {
    super(options);

    this.cleanupLimit = options.cleanupLimit;
    this.ttl = options.ttl;
  }

  public connect(repository: Repository<ISession>) {
    this.repository = repository;
    this.emit("connect");
    return this;
  }

  /**
   * Attempts to fetch session by the given `sid`.
   */
  public get = (sid: string, fn: (error?: any, result?: any) => void) => {
    this.debug('GET "%s"', sid);

    this.createQueryBuilder()
      .andWhere("id = :id", { id: sid })
      .getOne()
      .then((session) => {
        if (!session) { return fn(); }

        let result: any;
        this.debug("GOT %s", session.json);

        result = JSON.parse(session.json);
        fn(undefined, result);
      })
      .catch((er) => {
        fn(er);
        this.handleError(er);
      });
  }

  /**
   * Commits the given `sess` object associated with the given `sid`.
   */
  public set = (sid: string, sess: any, fn?: (error?: any) => void) => {
    const args = [sid];
    let json: string;

    try {
      json = JSON.stringify(sess);
    } catch (er) {
      return fn ? fn(er) : undefined;
    }

    args.push(json);

    const ttl = this.getTTL(sess, sid);
    args.push("EX", ttl.toString());
    this.debug('SET "%s" %s ttl:%s', sid, json, ttl);

    (this.cleanupLimit
      ? this.repository
        .createQueryBuilder("session")
        .delete()
        .where(`session.id IN (${
          this.repository.createQueryBuilder("_")
          .select("_.id")
          .where("_.expiredAt <= :expiredAt")
          .limit(this.cleanupLimit)
          .getQuery()})`)
        .setParameters({ expiredAt: Date.now() })
        .execute()
      : Promise.resolve())
      .then(() => this.saveSession({
        expiredAt: Date.now() + ttl * 1000,
        id: sid,
        json,
      }, sess))
      .then(() => {
        this.debug("SET complete");

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
  }

  /**
   * Destroys the session associated with the given `sid`.
   */
  public destroy = (sid: string | string[], fn?: (error?: any) => void) => {
    this.debug('DEL "%s"', sid);

    Promise.all((Array.isArray(sid) ? sid : [sid]).map((x) => this.repository.delete({ id: x })))
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
  }

  /**
   * Refreshes the time-to-live for the session with the given `sid`.
   */
  public touch = (sid: string, sess: any, fn?: (error?: any) => void) => {
    const ttl = this.getTTL(sess);

    this.debug('EXPIRE "%s" ttl:%s', sid, ttl);
    this.repository
      .createQueryBuilder()
      .update({ expiredAt: Date.now() + ttl * 1000 })
      .whereInIds([sid])
      .execute()
      .then(() => {
        this.debug("EXPIRE complete");

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
  }

  /**
   * Fetches all sessions.
   */
  public all = (fn: (error: any, result: any) => void) => {
    let result: any[] = [];

    this.createQueryBuilder()
      .getMany()
      .then((sessions) => {
        result = sessions.map((session) => {
          const sess = JSON.parse(session.json);
          sess.id = session.id;
          return sess;
        });

        fn(undefined, result);
      })
      .catch((er) => {
        fn(er, result);
        this.handleError(er);
      });
  }

  protected saveSession(session: ISession, sessionData: any): Promise<ISession> {
    // ignore TS6133 'sessionData' is declared but never read
    sessionData = sessionData;
    return this.repository.save(session);
  }

  private createQueryBuilder() {
    return this.repository.createQueryBuilder("session")
      .where("session.expiredAt > :expiredAt", { expiredAt: Date.now() });
  }

  private getTTL(sess: any, sid?: string) {
    if (typeof this.ttl === "number") { return this.ttl; }
    if (typeof this.ttl === "function") { return this.ttl(this, sess, sid); }

    const maxAge = sess.cookie.maxAge;
    return (typeof maxAge === "number"
      ? Math.floor(maxAge / 1000)
      : oneDay);
  }

  private handleError(er: Error) {
    this.debug("Typeorm returned err", er);
    this.emit("disconnect", er);
  }

}
