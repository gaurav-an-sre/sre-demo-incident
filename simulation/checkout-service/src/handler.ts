import { ConnectionPool } from "./pool.js";

const pool = new ConnectionPool(50);

export async function processCheckout(orderId: string): Promise<{ status: string }> {
  const conn = await pool.acquire();
  try {
    const success = Math.random() > 0.15;
    if (!success) {
      // Error path — triggers the pool leak in v2.14.3
      pool.releaseConnection(conn);
      return { status: "payment_failed" };
    }
    pool.releaseConnection(conn);
    return { status: "completed" };
  } catch (err) {
    return { status: "error" };
  }
}

export function getPoolStats() {
  return pool.stats();
}
