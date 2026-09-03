// Just enough of the Workers runtime types for this one file to typecheck
// without a dependency install (wrangler bundles TS without checking; this
// is for editors and `tsc --noEmit`).
interface D1Result<T = unknown> {
  results?: T[]
  meta: { changes?: number }
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  first<T = unknown>(): Promise<T | null>
  run<T = unknown>(): Promise<D1Result<T>>
  all<T = unknown>(): Promise<D1Result<T>>
}
interface D1Database {
  prepare(query: string): D1PreparedStatement
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
}
