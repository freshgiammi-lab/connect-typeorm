import test from 'ava';
import * as Express from 'express';
import * as ExpressSession from 'express-session';
import nullthrows from 'nullthrows';
import * as Supertest from 'supertest';
import { Column, DataSource, DeleteDateColumn, Entity, Index, PrimaryColumn, Repository } from 'typeorm';
import { ISession } from '../../domain/Session/ISession';
import { TypeormStore } from './TypeormStore';

test.beforeEach(async (t) => {
  const ctx = new Test();

  await ctx.componentDidMount();

  t.context = ctx;
});

test('destroys', async (t) => {
  const { request } = t.context as Test;

  t.is((await request.post('/views')).body, 1);
  t.is((await request.post('/views')).body, 2);
  t.is((await request.post('/views')).body, 3);

  await request.delete('/views');

  t.is((await request.post('/views')).body, 1);
});

test('sets, cleaning up expired', async (t) => {
  const { express, repository, request, ttl } = t.context as Test;

  const request1 = Supertest.agent(express);
  const request2 = Supertest.agent(express);
  const request3 = Supertest.agent(express);
  const request4 = Supertest.agent(express);
  const request5 = Supertest.agent(express);

  // Users 0 and 1 appear.
  t.is((await request.post('/views')).body, 1);
  t.is((await request1.post('/views')).body, 1);
  t.is(await repository.count(), 2);

  /**
   * User 0 returns. 1 hasn't expired yet. 2 and 3 appear.
   */
  await sleep(ttl / 2);
  t.is((await request.get('/views')).body, 1);
  t.is((await request2.post('/views')).body, 1);
  t.is((await request3.post('/views')).body, 1);
  t.is(await repository.count(), 4);

  /**
   * Users 0 and 2 return. 1 expired, but remains because nobody new
   * appears. 3 hasn't expired yet.
   */
  await sleep(ttl / 2);
  t.is((await request.get('/views')).body, 1);
  t.is((await request2.get('/views')).body, 1);
  t.is(await repository.count(), 4);

  /**
   * User 2 returns. 4 appears. Of the expired 1 and 3, somebody is
   * removed, and the other remains. 0 hasn't expired yet.
   */
  await sleep(ttl / 2);
  t.is((await request2.get('/views')).body, 1);
  t.is((await request4.post('/views')).body, 1);
  t.is(await repository.count(), 4);

  /**
   * Users 0, 2 and 4 return. 5 appears. Of the expired 1 and 3, the
   * remaining other is removed.
   */
  t.is((await request.get('/views')).body, 1);
  await sleep(ttl / 2);
  t.is((await request.get('/views')).body, 1);
  t.is((await request2.get('/views')).body, 1);
  t.is((await request4.get('/views')).body, 1);
  t.is((await request5.post('/views')).body, 1);
  t.is(await repository.count(), 4);

  /**
   * Users 0, 2, 4 and 5 return. 1 appears. Nobody is removed.
   */
  await sleep(ttl / 2);
  t.is((await request.get('/views')).body, 1);
  t.is((await request1.post('/views')).body, 1);
  t.is((await request2.get('/views')).body, 1);
  t.is((await request4.get('/views')).body, 1);
  t.is((await request5.get('/views')).body, 1);
  t.is(await repository.count(), 5);
});

test('touches', async (t) => {
  const { request, ttl } = t.context as Test;

  t.is((await request.post('/views')).body, 1);

  // Manage to touch before ttl expires.
  await sleep(ttl / 2);
  t.is((await request.get('/views')).body, 1);

  // Again.
  await sleep(ttl / 2);
  t.is((await request.get('/views')).body, 1);

  // Finally let session expire.
  await sleep(ttl);
  t.is((await request.get('/views')).body, 0);
});

test('touches, handling error', async (t) => {
  const ctx = t.context as Test;

  t.is((await ctx.request.post('/views')).body, 1);

  await ctx.componentWillUnmount();

  await ctx.request.get('/views').expect(/database.*not established/i);
});

test('race condition', async (t) => {
  const { request, repository, blockLogout, unblockReq1 } = t.context as Test;

  t.is((await request.post('/views')).body, 1);
  t.is((await request.post('/views')).body, 2);

  // hold logout until triggered by req to /race
  blockLogout.then(async () => {
    await request.delete('/views');
    // let /race continue
    unblockReq1();
  });
  // call to /race returns as expected as logout happens in between
  // because session.views was 2, race increments and returns 3
  t.is((await request.post('/race')).body, 3);

  // the record in the db should be deleted and should NOT be updated
  // i.e. views should still be at 2, not re-saved to 3
  const records = await repository.find({ withDeleted: true });
  t.is(records[0].json.views, 2);

  // session was deleted, so a new call results in a new session
  t.is((await request.post('/views')).body, 1);
});

test('cleanup after session destroy', async (t) => {
  const { request, repository, ttl, express } = t.context as Test;
  const request1 = Supertest.agent(express);
  t.is((await request.post('/views')).body, 1);

  // precondition; there is 1 session in the repository
  t.is(await repository.count({ withDeleted: true }), 1);

  // explicit logout
  await request.delete('/views');

  // another session starts before the original expires
  await sleep(ttl / 2);
  t.is((await request1.post('/views')).body, 1);
  t.is(await repository.count({ withDeleted: true }), 2);

  // allow the original session to reach natural expiry
  await sleep(ttl / 2);
  t.is((await request1.post('/views')).body, 2);

  // verify original record was removed with cleanup
  t.is(await repository.count({ withDeleted: true }), 1);
});

test.afterEach(async (t) => {
  const ctx = t.context as Test;

  await ctx.componentWillUnmount();
});

@Entity()
class Session implements ISession {
  @Index()
  @Column('bigint', { transformer: { from: Number, to: Number } })
  public expiredAt = Date.now();

  @PrimaryColumn('varchar', { length: 255 })
  public id = '';

  @Column({ type: 'simple-json' })
  public json!: ExpressSession.SessionData;

  @DeleteDateColumn()
  public destroyedAt?: Date;
}

class Test {
  public express = Express();

  public request = Supertest.agent(this.express);

  public repository!: Repository<Session>;

  public ttl = 2;

  // 'strictPropertyInitialization': false is required in tsconfig for this to work.
  public unblockReq1: (value?: unknown) => void;
  public unblockLogout: (value?: unknown) => void;
  public blockReq1: Promise<unknown>;
  public blockLogout: Promise<unknown>;

  private dataSource: DataSource | undefined;

  public async componentDidMount() {
    this.dataSource = await new DataSource({
      database: ':memory:',
      entities: [Session],
      // logging: ["query", "error"],
      synchronize: true,
      type: 'sqlite',
    }).initialize();

    this.blockReq1 = new Promise((resolve) => {
      this.unblockReq1 = resolve;
    });
    this.blockLogout = new Promise((resolve) => {
      this.unblockLogout = resolve;
    });

    this.repository = this.dataSource.getRepository(Session);

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
      })
    );

    this.express.delete('/views', (req, res) => {
      const session = nullthrows(req.session);

      session.destroy((error) => res.status(error ? 500 : 200).json(error || null));
    });

    this.express.get('/views', (req, res) => {
      const session = nullthrows(req.session);

      res.json(session.views || 0);
    });

    this.express.post('/views', (req, res) => {
      const session = nullthrows(req.session);

      session.views = (session.views || 0) + 1;

      res.json(session.views);
    });

    this.express.post('/race', async (req, res) => {
      const session = nullthrows(req.session);

      session.views = (session.views || 0) + 1;

      this.unblockLogout();
      this.blockReq1.then(() => {
        return res.json(session.views);
      });
    });
  }

  public async componentWillUnmount() {
    if (this.dataSource) {
      await this.dataSource.destroy();

      this.dataSource = undefined;
    }
  }
}

function sleep(timeout: number) {
  return new Promise((resolve) => setTimeout(resolve, timeout * 1e3));
}
