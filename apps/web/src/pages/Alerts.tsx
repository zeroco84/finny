import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Alert } from '@finny/shared';
import { api } from '../api';
import { dateTime } from '../format';
import { useMeta } from '../meta';
import { EmptyState } from '../components/ui';

export default function AlertsPage() {
  const { refreshOverview } = useMeta();
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [filter, setFilter] = useState<'open' | 'all'>('open');

  const load = useCallback(async () => {
    setAlerts(await api.alerts(filter === 'open' ? 'open' : undefined));
  }, [filter]);

  useEffect(() => {
    setAlerts(null);
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  async function setStatus(alert: Alert, status: 'ack' | 'resolve') {
    if (status === 'ack') await api.ackAlert(alert.id);
    else await api.resolveAlert(alert.id);
    await load();
    await refreshOverview();
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Alerts</h1>
        <div className="tabs">
          <button className={`tab ${filter === 'open' ? 'tab-active' : ''}`} onClick={() => setFilter('open')}>Open</button>
          <button className={`tab ${filter === 'all' ? 'tab-active' : ''}`} onClick={() => setFilter('all')}>All</button>
        </div>
      </div>
      <p className="muted">
        Every failure — unreadable file, stuck low-confidence invoice, Sage or Teams error, mailbox outage —
        raises one of these immediately and posts it to your subscribed Teams channel. Nothing fails silently.
      </p>

      {alerts === null ? (
        <p className="muted">Loading…</p>
      ) : alerts.length === 0 ? (
        <EmptyState
          title={filter === 'open' ? 'No open alerts' : 'No alerts yet'}
          hint='Try "Simulate incoming → Corrupt attachment" on the queue to see the alert flow.'
        />
      ) : (
        <div className="alert-list">
          {alerts.map((alert) => (
            <div key={alert.id} className={`card alert-card alert-${alert.severity} alert-status-${alert.status}`}>
              <div className="alert-head">
                <strong>{alert.subject}</strong>
                <span className={`chip alert-chip-${alert.status}`}>{alert.status}</span>
              </div>
              <pre className="alert-body">{alert.message}</pre>
              <div className="alert-meta">
                <span>{dateTime(alert.created_at)}</span>
                <span>
                  {alert.delivery_status === 'sent' && `posted to Teams (${alert.delivery_target}) at ${dateTime(alert.delivery_at)}`}
                  {alert.delivery_status === 'logged' && 'not sent — no alert webhook set (Settings → Thresholds & alerts)'}
                  {alert.delivery_status === 'failed' && `Teams post FAILED: ${alert.delivery_error}`}
                </span>
                {alert.invoice_id && <Link to={`/invoices/${alert.invoice_id}`}>Open invoice →</Link>}
              </div>
              {alert.status !== 'resolved' && (
                <div className="alert-actions">
                  {alert.status === 'open' && (
                    <button className="btn btn-small" onClick={() => void setStatus(alert, 'ack')}>Acknowledge</button>
                  )}
                  <button className="btn btn-small btn-primary" onClick={() => void setStatus(alert, 'resolve')}>Resolve</button>
                </div>
              )}
              {alert.acknowledged_by && (
                <p className="muted small">
                  {alert.status === 'resolved' ? 'Resolved' : 'Acknowledged'} by {alert.acknowledged_by} at {dateTime(alert.acknowledged_at)}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
