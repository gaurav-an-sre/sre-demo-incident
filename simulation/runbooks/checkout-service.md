# Checkout Service Incident Runbook

## Alert: CheckoutServiceHighLatency

**Severity:** P1  
**Service:** checkout-service  
**Team:** payments-platform

## Immediate Actions

1. Check Grafana dashboard for latency and error rate trends
2. Review recent deploys in the last 2 hours
3. Inspect connection pool metrics (`pool_available`, `pool_in_use`)
4. Check payment-gateway dependency health
5. If pool exhausted: restart checkout-service pods to recover connections

## Common Root Causes

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Pool exhaustion after deploy | Connection leak in pool management | Rollback or hotfix pool.ts, restart service |
| ECONNREFUSED to payment-gateway | Upstream outage | Failover to secondary gateway |
| Gradual latency increase | Memory leak or thread starvation | Heap dump, restart, profile |

## Escalation

- L1: Restart service (buys ~30 min)
- L2: Rollback to last stable version
- L3: Page payments-platform lead + payment-gateway on-call

## Post-Incident

Create incident page and postmortem in Notion within 48 hours.
