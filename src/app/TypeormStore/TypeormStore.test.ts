// tslint:disable:max-classes-per-file
// tslint:disable:no-implicit-dependencies

import test from "ava";
import * as Express from "express";
import * as ExpressSession from "express-session";
import nullthrows from "nullthrows";
import * as Supertest from "supertest";
import {
  Column,
  Connection,
  createConnection,
  Entity,
  Index,
  PrimaryColumn,
  Repository,
} from "typeorm";
import { ISession } from "../../domain/Session/ISession";
import { TypeormStore } from "./TypeormStore";

test.beforeEach(async (t) => {
  const ctx = new Test();

  await ctx.componentDidMount();

  t.context = ctx;
});

test("destroys", async (t) => {
  const { request } = t.context as Test;

  t.is((await request.post("/views")).body, 1);
  t.is((await request.post("/views")).body, 2);
  t.is((await request.post("/views")).body, 3);

  await request.delete("/views");

  t.is((await request.post("/views")).body, 1);
});

test("sets, cleaning up expired", async (t) => {
  const { express, repository, request, ttl } = t.context as Test;

  const request1 = Supertest.agent(express);
  const request2 = Supertest.agent(express);
  const request3 = Supertest.agent(express);
  const request4 = Supertest.agent(express);
  const request5 = Supertest.agent(express);

  // Users 0 and 1 appear.
  t.is((await request.post("/views")).body, 1);
  t.is((await request1.post("/views")).body, 1);
  t.is((await repository.count()), 2);

  /**
   * User 0 returns. 1 hasn't expired yet. 2 and 3 appear.
   */
  await sleep(ttl / 2);
  t.is((await request.get("/views")).body, 1);
  t.is((await request2.post("/views")).body, 1);
  t.is((await request3.post("/views")).body, 1);
  t.is((await repository.count()), 4);

  /**
   * Users 0 and 2 return. 1 expired, but remains because nobody new
   * appears. 3 hasn't expired yet.
   */
  await sleep(ttl / 2);
  t.is((await request.get("/views")).body, 1);
  t.is((await request2.get("/views")).body, 1);
  t.is((await repository.count()), 4);

  /**
   * User 2 returns. 4 appears. Of the expired 1 and 3, somebody is
   * removed, and the other remains. 0 hasn't expired yet.
   */
  await sleep(ttl / 2);
  t.is((await request2.get("/views")).body, 1);
  t.is((await request4.post("/views")).body, 1);
  t.is((await repository.count()), 4);

  /**
   * Users 0, 2 and 4 return. 5 appears. Of the expired 1 and 3, the
   * remaining other is removed.
   */
  t.is((await request.get("/views")).body, 1);
  await sleep(ttl / 2);
  t.is((await request.get("/views")).body, 1);
  t.is((await request2.get("/views")).body, 1);
  t.is((await request4.get("/views")).body, 1);
  t.is((await request5.post("/views")).body, 1);
  t.is((await repository.count()), 4);

  /**
   * Users 0, 2, 4 and 5 return. 1 appears. Nobody is removed.
   */
  await sleep(ttl / 2);
  t.is((await request.get("/views")).body, 1);
  t.is((await request1.post("/views")).body, 1);
  t.is((await request2.get("/views")).body, 1);
  t.is((await request4.get("/views")).body, 1);
  t.is((await request5.get("/views")).body, 1);
  t.is((await repository.count()), 5);
});

test("touches", async (t) => {
  const { request, ttl } = t.context as Test;

  t.is((await request.post("/views")).body, 1);

  // Manage to touch before ttl expires.
  await sleep(ttl / 2);
  t.is((await request.get("/views")).body, 1);

  // Again.
  await sleep(ttl / 2);
  t.is((await request.get("/views")).body, 1);

  // Finally let session expire.
  await sleep(ttl);
  t.is((await request.get("/views")).body, 0);
});

test("touches, handling error", async (t) => {
  const ctx = t.context as Test;

  t.is((await ctx.request.post("/views")).body, 1);

  await ctx.componentWillUnmount();

  await ctx.request.get("/views").expect(/database.*closed/i);
});

test("allows database to fail and recover", async (t) => {
  const ctx = t.context as Test;

  // Disconnect from the DB, make the repository raise an error
  await ctx.disconnect();
  await ctx.request.post("/views");

  // Reconnect to the DB, and make sure we can log in again
  await ctx.connect();
  await ctx.request.post("/views");
  t.is((await ctx.request.get("/views")).body, 1);
});

test.afterEach(async (t) => {
  const ctx = t.context as Test;

  await ctx.componentWillUnmount();
});

@Entity()
class Session implements ISession {
  @Index()
  @Column("bigint", { transformer: { from: Number, to: Number } })
  public expiredAt = Date.now();

  @PrimaryColumn("varchar", { length: 255 })
  public id = "";

  @Column("text")
  public json = "";
}

class Test {
  public express = Express();

  public request = Supertest.agent(this.express);

  public repository!: Repository<Session>;

  public ttl = 2;

  private connection: Connection | undefined;

  public async componentDidMount() {
    this.connection = await createConnection({
      database: ":memory:",
      entities: [Session],
      synchronize: true,
      type: "sqlite",
    });

    this.repository = this.connection.getRepository(Session);

    this.express.use(
      ExpressSession({
        resave: false,
        saveUninitialized: false,
        secret: Math.random().toString(),
        store: new TypeormStore({
          cleanupLimit: 1,
          limitSubquery: false,
          ttl: this.ttl,
        }).connect(this.repository),
      }),
    );

    this.express.delete("/views", (req, res) => {
      const session = nullthrows(req.session);

      session.destroy((error) =>
        res.status(error ? 500 : 200).json(error || null),
      );
    });

    this.express.get("/views", (req, res) => {
      const session = nullthrows(req.session);

      res.json(session.views || 0);
    });

    this.express.post("/views", (req, res) => {
      const session = nullthrows(req.session);

      session.views = (session.views || 0) + 1;

      res.json(session.views);
    });
  }

  public async componentWillUnmount() {
    if (this.connection) {
      await this.connection.close();

      this.connection = undefined;
    }
  }

  public async disconnect() {
    return this.connection?.close();
  }

  public async connect() {
    return this.connection?.connect();
  }
}

function sleep(timeout: number) {
  return new Promise((resolve) => setTimeout(resolve, timeout * 1e3));
}
