# connect-typeorm

A TypeORM-based session store.

## Setup & Usage

Configure TypeORM with back end of your choice:

### NPM
```bash
npm install connect-typeorm express-session typeorm sqlite3
npm install -D @types/express-session 
```

## Implement the `Session` entity:

```typescript
// src/domain/Session/Session.ts

import { ISession } from "connect-typeorm";
import { Column, DeleteDateColumn, Entity, Index, PrimaryColumn } from "typeorm";

@Entity()
export class Session implements ISession {
    @Index()
    @Column("bigint")
    public expiredAt = Date.now();

    @PrimaryColumn("varchar", { length: 255 })
    public id = "";

    @Column("text")
    public json = "";

    @DeleteDateColumn()
    public destroyedAt?: Date;
}
```

Pass repository to `TypeormStore`:

```typescript
// src/app/Api/Api.ts

import { TypeormStore } from "connect-typeorm";
import { getRepository } from "typeorm";
import * as Express from "express";
import * as ExpressSession from "express-session";

import { Session } from "../../domain/Session/Session";

export class Api {
    public sessionRepository = getRepository(Session);

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

TypeORM uses `{ "bigNumberStrings": true }` option by default for node-mysql,
you can use a Transformer to fix this issue:
```typescript
import { Bigint } from "typeorm-static";

@Column("bigint", { transformer: Bigint })
````

## Options

Constructor receives an object. Following properties may be included:

- `cleanupLimit` For every new session, remove this many expired ones (does not distinguish between users, so User A logging in can delete User B expired sessions). Defaults to 0, in case you need to analyze sessions retrospectively.

- `limitSubquery` Select and delete expired sessions in one query. Defaults to true, you can set false to make two queries, in case you want cleanupLimit but your MariaDB version doesn't support limit in a subquery.

-	`ttl` Session time to live (expiration) in seconds. Defaults to session.maxAge (if set), or one day. This may also be set to a function of the form `(store, sess, sessionID) => number`.

-	`onError` Error handler for database exception. It is a function of the form `(store: TypeormStore, error: Error) => void`. If not set, any database error will cause the TypeormStore to be marked as "disconnected", and stop reading/writing to the database, therefore not loading sessions and causing all requests to be considered unauthenticated.

## License

MIT
