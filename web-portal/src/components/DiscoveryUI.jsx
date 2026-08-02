import React, { useState, useEffect } from 'react';
import { api } from '../api';

const Button = ({ children, variant = 'primary', onClick, disabled = false, full = false }) => {
  const base = `${full ? 'w-full' : ''} px-4 py-1 rounded text-xs font-bold tracking-wider transition-all duration-200 uppercase font-mono`;
  const variants = {
    primary:   'bg-specter-primary-cyan text-specter-bg-surface hover:bg-specter-primary-neon hover:shadow-[0_0_10px_rgba(6,182,212,0.3)]',
    secondary: 'bg-specter-bg-panel text-specter-text-muted hover:text-specter-text-main border border-specter-bg-panel hover:border-specter-primary-dim',
    warning:   'bg-specter-state-warning/20 text-specter-state-warning border border-specter-state-warning/50',
  };
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${variants[variant]} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}>
      {children}
    </button>
  );
};

const DiscoveryUI = ({ onClose, onJoin }) => {
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [joinState, setJoinState] = useState({}); // { [serverId]: 'joining' | 'joined' | 'applied' | 'error' }
  const [joinErrors, setJoinErrors] = useState({}); // { [serverId]: 'error message' }

  useEffect(() => {
    const fetchServers = async () => {
      setLoading(true);
      const { data, error } = await api.getPublicOrgs();
      if (error) {
        setError(error);
      } else {
        setServers(data.servers || []);
      }
      setLoading(false);
    };
    fetchServers();
  }, []);

  const handleJoin = async (serverId) => {
    setJoinState(prev => ({ ...prev, [serverId]: 'joining' }));
    setJoinErrors(prev => { const n = { ...prev }; delete n[serverId]; return n; });

    const { data, error } = await api.joinOrg(serverId);

    if (error) {
      if (error.includes('Already')) {
        onJoin(serverId);
        return;
      }
      setJoinState(prev => ({ ...prev, [serverId]: 'error' }));
      setJoinErrors(prev => ({ ...prev, [serverId]: error }));
      return;
    }

    if (data?.message?.includes('Application')) {
      setJoinState(prev => ({ ...prev, [serverId]: 'applied' }));
    } else {
      setJoinState(prev => ({ ...prev, [serverId]: 'joined' }));
      setTimeout(() => onJoin(serverId), 500);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50">
      <div className="bg-specter-bg-surface border border-specter-primary-dim rounded-lg p-6 w-full max-w-2xl max-h-[80vh] flex flex-col font-mono">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl text-specter-primary-cyan uppercase tracking-widest">[ PUBLIC DIRECTORY ]</h2>
          <Button variant="secondary" onClick={onClose}>X</Button>
        </div>

        {error && <div className="text-red-400 text-xs mb-4">{error}</div>}

        <div className="overflow-y-auto flex-1 space-y-3 pr-2">
          {loading ? (
            <div className="text-specter-text-muted text-center py-8 text-xs">Scanning frequencies...</div>
          ) : servers.length === 0 ? (
            <div className="text-specter-text-muted text-center py-8 text-xs">No public signals detected.</div>
          ) : (
            servers.map(server => {
              const state = joinState[server.id];
              return (
                <div key={server.id} className="bg-specter-bg-panel border border-specter-primary-dim rounded p-4 flex justify-between items-center">
                  <div>
                    <div className="text-specter-text-main font-bold text-lg">{server.callsign}</div>
                    {server.description && <div className="text-specter-text-muted text-xs mt-1">{server.description}</div>}
                    <div className="text-specter-primary-cyan text-xs mt-2">{server.member_count} Members</div>
                    {state === 'error' && joinErrors[server.id] && (
                      <div className="text-red-400 text-xs mt-1">{joinErrors[server.id]}</div>
                    )}
                  </div>
                  <div>
                    {state === 'joining' && <Button disabled>Joining...</Button>}
                    {state === 'joined'  && <Button disabled>Joined ✓</Button>}
                    {state === 'applied' && <Button disabled variant="warning">Pending</Button>}
                    {(!state || state === 'error') && (
                      <Button onClick={() => handleJoin(server.id)}>Add to List</Button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

export default DiscoveryUI;
