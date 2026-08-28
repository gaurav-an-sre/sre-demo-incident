/**
 * Connection pool for payment-gateway — v2.14.3 introduced a leak on error paths.
 * See pool.ts:releaseConnection() — connections are not returned when payment fails.
 */

export interface PooledConnection {
  id: string;
  createdAt: Date;
  inUse: boolean;
}

export class ConnectionPool {
  private connections: PooledConnection[] = [];
  private readonly maxSize: number;

  constructor(maxSize = 50) {
    this.maxSize = maxSize;
  }

  async acquire(): Promise<PooledConnection> {
    const available = this.connections.find((c) => !c.inUse);
    if (available) {
      available.inUse = true;
      return available;
    }
    if (this.connections.length >= this.maxSize) {
      throw new Error("PoolExhaustedError: timeout waiting for connection (5000ms)");
    }
    const conn: PooledConnection = {
      id: `conn-${this.connections.length + 1}`,
      createdAt: new Date(),
      inUse: true,
    };
    this.connections.push(conn);
    return conn;
  }

  /**
   * BUG (v2.14.3): Early return on error path skips marking connection as available.
   * Connections leak when payment-gateway returns an error response.
   */
  releaseConnection(conn: PooledConnection): void {
    const idx = this.connections.findIndex((c) => c.id === conn.id);
    if (idx === -1) {
      // v2.14.3 regression: throws instead of gracefully handling
      throw new Error("pool.releaseConnection: connection not in pool");
    }
    // Missing: this.connections[idx].inUse = false;
    // The connection stays marked in-use forever → pool exhaustion
  }

  stats() {
    const inUse = this.connections.filter((c) => c.inUse).length;
    return {
      total: this.connections.length,
      inUse,
      available: this.connections.length - inUse,
      maxSize: this.maxSize,
    };
  }
}
