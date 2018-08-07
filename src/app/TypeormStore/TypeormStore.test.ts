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
} from "typeorm";
import { ISession } from "../../domain/Session/ISession";
import { TypeormStore } from "./TypeormStore";

test.beforeEach(async (t) => {
  const ctx = new Test();

  await ctx.componentDidMount();

  t.context = ctx;
});

test("destroys", async (t) => {
  const { request }: Test = t.context;

  t.is((await request.post("/views")).body, 1);
  t.is((await request.post("/views")).body, 2);
  t.is((await request.post("/views")).body, 3);

  await request.delete("/views");

  t.is((await request.post("/views")).body, 1);
});

test("reloads", async (t) => {
  const { request }: Test = t.context;

  t.is((await request.post("/views")).body, 1);
  t.is((await request.post("/views")).body, 2);
  t.is((await request.get("/views")).body, 2);
});

test("reloads, handling error", async (t) => {
  const ctx: Test = t.context;

  t.is((await ctx.request.post("/views")).body, 1);

  await ctx.componentWillUnmount();

  await ctx.request.get("/views").expect(/database.*closed/i);
});

test("sets, touching and expiring", async (t) => {
  const { request, ttl }: Test = t.context;

  t.is((await request.post("/views")).body, 1);

  // Manage to touch before ttl expires.
  await new Promise((resolve) => setTimeout(resolve, ttl / 2 * 1e3));
  t.is((await request.post("/views")).body, 2);

  // Again.
  await new Promise((resolve) => setTimeout(resolve, ttl / 2 * 1e3));
  t.is((await request.post("/views")).body, 3);

  // Finally let session expire.
  await new Promise((resolve) => setTimeout(resolve, ttl * 1e3));
  t.is((await request.post("/views")).body, 1);
});

test.afterEach(async (t) => {
  const ctx: Test = t.context;

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
  public request!: Supertest.SuperTest<Supertest.Test>;

  public ttl = 1;

  private connection: Connection | undefined;

  public async componentDidMount() {
    this.connection = await createConnection({
      database: ":memory:",
      entities: [Session],
      synchronize: true,
      type: "sqlite",
    });

    const repository = this.connection.getRepository(Session);

    const express = Express().use(
      ExpressSession({
        resave: false,
        saveUninitialized: false,
        secret: Math.random().toString(),
        store: new TypeormStore({ ttl: this.ttl }).connect(repository),
      }),
    );

    express.delete("/views", (req, res) => {
      const session = nullthrows(req.session);

      session.destroy((error) =>
        res.status(error ? 500 : 200).json(error || session.views || 0),
      );
    });

    express.get("/views", (req, res) => {
      const session = nullthrows(req.session);

      session.reload((error) =>
        res.status(error ? 500 : 200).json(error || session.views),
      );
    });

    express.post("/views", (req, res) => {
      const session = nullthrows(req.session);

      session.views = (session.views || 0) + 1;

      session.save((error) =>
        res.status(error ? 500 : 200).json(error || session.views),
      );
    });

    this.request = Supertest.agent(express);
  }

  public async componentWillUnmount() {
    if (this.connection) {
      await this.connection.close();

      this.connection = undefined;
    }
  }
}
