import test from 'ava';
import * as Express from 'express';
import * as ExpressSession from 'express-session';
import nullthrows from 'nullthrows';
import * as Supertest from 'supertest';
import { Column, DataSource, DeleteDateColumn, Entity, Index, PrimaryColumn, Repository } from 'typeorm';
import { ISession } from '../../domain/Session/ISession';
import { TypeormStore } from './TypeormStore';

@Entity()
class Session implements ISession {
  @Index()
  @Column('bigint', { transformer: { from: Number, to: Number } })
  public expiredAt = Date.now();

  @PrimaryColumn('varchar', { length: 255 })
  public id = '';

  @DeleteDateColumn()
  public destroyedAt?: Date;

  @Column({ type: 'simple-json' })
  public json!: ExpressSession.SessionData;
}

class Test {
  public dataSource: DataSource;
  public express = Express();
  public request = Supertest.agent(this.express);
  public repository!: Repository<Session>;
  public async connect() {
    this.dataSource = await new DataSource({
      database: ':memory:',
      entities: [Session],
      synchronize: true,
      type: 'sqlite',
    }).initialize();
    this.repository = this.dataSource.getRepository(Session);
  }
  // Between calling connect() and route(), I'll register stores differently.
  public route() {
    this.express.get('/views', (req, res) => {
      const session = nullthrows(req.session);
      res.json(session.views || 0);
    });
    this.express.post('/views', (req, res) => {
      const session = nullthrows(req.session);
      session.views = (session.views || 0) + 1;
      res.json(session.views);
    });
  }
}

test('increments as expected when no error happens', async (t) => {
  const ctx = new Test();
  await ctx.connect();
  ctx.express.use(
    ExpressSession({
      resave: false,
      saveUninitialized: false,
      secret: Math.random().toString(),
      store: new TypeormStore({ limitSubquery: false }).connect(ctx.repository),
    })
  );
  ctx.route();

  await ctx.request.post('/views');
  t.is((await ctx.request.get('/views')).body, 1);
  await ctx.request.post('/views');
  t.is((await ctx.request.get('/views')).body, 2);

  await ctx.dataSource.destroy();
});

test('disconnects on error to prevent more damage', async (t) => {
  const ctx = new Test();
  await ctx.connect();
  ctx.express.use(
    ExpressSession({
      resave: false,
      saveUninitialized: false,
      secret: Math.random().toString(),
      store: new TypeormStore({ limitSubquery: false }).connect(ctx.repository),
    })
  );
  ctx.route();

  await ctx.request.post('/views');
  t.is((await ctx.request.get('/views')).status, 200);

  await ctx.dataSource.destroy();
  await ctx.request.post('/views');
  t.is((await ctx.request.get('/views')).status, 500);

  await ctx.dataSource.initialize();
  // Database reconnected, but express-session has set storeReady=false.
  await ctx.request.post('/views');
  t.is((await ctx.request.get('/views')).status, 500);

  await ctx.dataSource.destroy();
});

test('but allows you to override this', async (t) => {
  const ctx = new Test();
  await ctx.connect();
  let error = new Error();
  ctx.express.use(
    ExpressSession({
      resave: false,
      saveUninitialized: false,
      secret: Math.random().toString(),
      store: new TypeormStore({
        limitSubquery: false,
        onError: (_, e) => (error = e),
      }).connect(ctx.repository),
    })
  );
  ctx.route();

  await ctx.request.post('/views');
  t.is((await ctx.request.get('/views')).status, 200);

  await ctx.dataSource.destroy();
  await ctx.request.post('/views');
  t.is((await ctx.request.get('/views')).status, 500);
  t.is(!!error.message, true);

  error = new Error();
  await ctx.dataSource.initialize();
  // Database reconnected, and express-session remains storeReady=true.
  await ctx.request.post('/views');
  t.is((await ctx.request.get('/views')).status, 200);
  t.is(error.message, '');

  await ctx.dataSource.destroy();
});

test('with the same behavior, if you wish', async (t) => {
  const ctx = new Test();
  await ctx.connect();
  let error = new Error();
  ctx.express.use(
    ExpressSession({
      resave: false,
      saveUninitialized: false,
      secret: Math.random().toString(),
      store: new TypeormStore({
        limitSubquery: false,
        onError: (store, e) => {
          error = e;
          store.emit('disconnect');
          // You can handle error here and emit "connect" again when ready.
        },
      }).connect(ctx.repository),
    })
  );
  ctx.route();

  await ctx.request.post('/views');
  t.is((await ctx.request.get('/views')).status, 200);

  await ctx.dataSource.destroy();
  await ctx.request.post('/views');
  t.is((await ctx.request.get('/views')).status, 500);
  t.is(!!error.message, true);

  await ctx.dataSource.initialize();
  await ctx.request.post('/views');
  t.is((await ctx.request.get('/views')).status, 500);

  await ctx.dataSource.destroy();
});
