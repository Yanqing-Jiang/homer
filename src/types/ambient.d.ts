// Ambient type declarations for packages without compatible @types/*.
// better-sqlite3@11.x has no @types support (v7.6.x types are incompatible).

// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace Database {
  interface Database {
    prepare<T = any>(sql: string): Statement<T>;
    exec(sql: string): this;
    transaction<T extends (...args: any[]) => any>(fn: T): T;
    pragma(pragma: string, options?: { simple?: boolean }): any;
    close(): void;
    backup(destinationFile: string, options?: any): Promise<any>;
    readonly open: boolean;
    readonly inTransaction: boolean;
    readonly name: string;
    readonly memory: boolean;
    readonly readonly: boolean;
  }

  interface Statement<T = any> {
    run(...params: any[]): RunResult;
    get(...params: any[]): T | undefined;
    all(...params: any[]): T[];
    iterate(...params: any[]): IterableIterator<T>;
    pluck(toggleState?: boolean): this;
    expand(toggleState?: boolean): this;
    columns(): any[];
    bind(...params: any[]): this;
    readonly source: string;
    readonly reader: boolean;
  }

  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }
}

declare module "better-sqlite3" {
  interface DatabaseConstructor {
    new (filename: string | Buffer, options?: any): Database.Database;
    (filename: string | Buffer, options?: any): Database.Database;
  }
  const ctor: DatabaseConstructor;
  export = ctor;
}

declare module "blessed";
declare module "jsonwebtoken";
