import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Approver, Overview, SessionUser, Settings } from '@finny/shared';
import { api } from './api';

interface Meta {
  user: SessionUser;
  settings: Settings;
  approvers: Approver[];
  overview: Overview | null;
  approverName: (id: string | null) => string;
  refreshMeta: () => Promise<void>;
  refreshOverview: () => Promise<void>;
  signOut: () => Promise<void>;
}

const MetaContext = createContext<Meta | null>(null);

export function useMeta(): Meta {
  const meta = useContext(MetaContext);
  if (!meta) throw new Error('useMeta outside provider');
  return meta;
}

export function MetaProvider({
  user,
  onSignOut,
  children,
}: {
  user: SessionUser;
  onSignOut: () => void;
  children: ReactNode;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [approvers, setApprovers] = useState<Approver[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);

  const refreshMeta = useCallback(async () => {
    const [s, a] = await Promise.all([api.settings(), api.approvers()]);
    setSettings(s);
    setApprovers(a);
  }, []);

  const refreshOverview = useCallback(async () => {
    try {
      setOverview(await api.overview());
    } catch {
      /* transient — badge refresh only */
    }
  }, []);

  useEffect(() => {
    void refreshMeta();
    void refreshOverview();
    const timer = setInterval(() => void refreshOverview(), 5000);
    return () => clearInterval(timer);
  }, [refreshMeta, refreshOverview]);

  if (!settings) return <div className="page-loading">Loading Finny…</div>;

  const approverName = (id: string | null): string => {
    if (!id) return '—';
    return approvers.find((a) => a.id === id)?.name ?? 'Unknown';
  };

  return (
    <MetaContext.Provider
      value={{
        user,
        settings,
        approvers,
        overview,
        approverName,
        refreshMeta,
        refreshOverview,
        signOut: async () => {
          await api.logout();
          onSignOut();
        },
      }}
    >
      {children}
    </MetaContext.Provider>
  );
}
