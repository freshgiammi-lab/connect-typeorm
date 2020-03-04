# connect-typeorm

A TypeORM-based session store.

## Usage

Configure TypeORM with back end of your choice:

```bash
yarn add @types/express-session connect-typeorm express-session typeorm sqlite3
```

Implement the `Session` entity:

```typescript
// src/domain/Session/Session.ts

import { ISession } from "connect-typeorm";
import { Column, Entity, Index, PrimaryColumn } from "typeorm";
@Entity()
export class Session implements ISession {
  @Index()
  @Column("bigint")
  public expiredAt = Date.now();

  @PrimaryColumn("varchar", { length: 255 })
  public id = "";

  @Column("text")
  public json = "";
}
```

Pass repository to `TypeormStore`:

```typescript
// src/app/Api/Api.ts

import * as Express from "express";
import * as ExpressSession from "express-session";
import { Db } from "typeorm-static";
import { Session } from "../../domain/Session/Session";

export class Api {
  public sessionRepository = Db.connection.getRepository(Session);

  public express = Express().use(
    ExpressSession({
      resave: false,
      saveUninitialized: false,
      store: new TypeormStore({
        cleanupLimit: 2,
        limitSubquery: false, // If using MariaDB.
        ttl: 86400
      }).connect(this.sessionRepository),
      secret: "keyboard cat"
    })
  );
}
```

TypeORM uses `{ "bigNumberStrings": true }` option by default for node-mysql,
you can use a Transformer to fix this issue:
```typescript
import { Bigint } from "typeorm-static";
@Column("bigint", { transformer: Bigint })
````

## Options

Constructor receives an object. Following properties may be included:

- `cleanupLimit` For every new session, remove this many expired ones. Defaults to 0, in case you need to analyze sessions retrospectively.

- `limitSubquery` Select and delete expired sessions in one query. Defaults to true, you can set false to make two queries, in case you want cleanupLimit but your MariaDB version doesn't support limit in a subquery.

-	`ttl` Session time to live (expiration) in seconds. Defaults to session.maxAge (if set), or one day. This may also be set to a function of the form `(store, sess, sessionID) => number`.

## License

MIT
