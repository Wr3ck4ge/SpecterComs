// P2C: the tray strip's Games cabinet — "Supported games" (the same list an
// operation can be tagged with, gameOptions.js) → a game's tools. Picking a
// tool opens it as a wide panel beside the cabinet (games/GameToolPanel,
// lazy-loaded by StripApp). Also carries the per-user "I play this" flag
// (/users/games) that used to be Settings → Games in the main window.
import { useEffect, useState } from 'react';
import { ChevronLeft, Gamepad2, Rocket, Wrench, X } from 'lucide-react';
import { Alert, IconButton, Row, Toggle } from '../ui';
import { api as realApi } from '../../api';
import { GAME_OPTIONS } from '../../gameOptions';
import { GAME_BLURB, GAME_TOOLS } from './games/gameTools';

const TOOL_ICONS = { hangar: Rocket, editor: Wrench };

// 'STAR CITIZEN' → 'Star Citizen'
const gameTitle = (label) => label.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
export const SUPPORTED_GAMES = GAME_OPTIONS.filter((g) => g.v !== 'none').map((g) => ({ id: g.v, title: gameTitle(g.l) }));

/**
 * activeTool       { game, tool } | null — highlights the open tool
 * onOpenTool(game, toolId), onClose(), maxHeight
 * initialGame      dev preview
 * api              defaults to the real client
 */
export default function GamesCabinet({ activeTool, onOpenTool, onClose, maxHeight = 560, initialGame = null, api = realApi }) {
  const [gameId, setGameId] = useState(initialGame ?? activeTool?.game ?? null);
  const [myGames, setMyGames] = useState(null);
  const [mineError, setMineError] = useState(null);
  const game = SUPPORTED_GAMES.find((g) => g.id === gameId) || null;

  useEffect(() => {
    let stale = false;
    api.getMyGames().then(({ data, error }) => {
      if (stale) return;
      if (error) { setMyGames([]); return; }
      setMyGames(data?.games || []);
    }).catch(() => { if (!stale) setMyGames([]); });
    return () => { stale = true; };
  }, [api]);

  const toggleMine = async (id, on) => {
    const prev = myGames || [];
    const next = on ? [...new Set([...prev, id])] : prev.filter((g) => g !== id);
    setMyGames(next);
    setMineError(null);
    const { error } = await api.updateMyGames(next);
    if (error) { setMyGames(prev); setMineError(typeof error === 'string' ? error : 'Could not save'); }
  };

  return (
    <div className="flex flex-col" style={{ maxHeight }}>
      <div className="flex items-center gap-1 px-2 pt-3 pb-2">
        {game ? <IconButton size="sm" icon={<ChevronLeft size={16} />} label="All games" onClick={() => setGameId(null)} /> : <span className="w-2" />}
        <div className="flex-1 min-w-0">
          <h2 className="truncate text-ui-lg font-semibold text-specter-text-main">{game ? game.title : 'Supported games'}</h2>
          {!game && <p className="text-ui-sm text-specter-text-subtle">Tools for the games your server plays</p>}
        </div>
        <IconButton icon={<X size={16} />} label="Close" size="sm" onClick={onClose} />
      </div>
      <div className="strip-scroll min-h-0 flex-1 px-2 pb-3">
        {!game && (
          <div className="space-y-0.5" key="list">
            {SUPPORTED_GAMES.map((g) => (
              <Row key={g.id} icon={<Gamepad2 size={16} />} title={g.title}
                subtitle={`${(GAME_TOOLS[g.id] || []).length} tools${myGames?.includes(g.id) ? ' · in your games' : ''}`}
                onClick={() => setGameId(g.id)} />
            ))}
          </div>
        )}
        {game && (
          <div key={game.id} className="strip-cabinet-swap space-y-3">
            {GAME_BLURB[game.id] && <p className="px-2 text-ui-sm text-specter-text-muted">{GAME_BLURB[game.id]}</p>}
            <div className="space-y-0.5">
              {(GAME_TOOLS[game.id] || []).map((t) => {
                const Icon = TOOL_ICONS[t.id] || Wrench;
                return (
                  <Row key={t.id} icon={<Icon size={16} />} title={t.title} subtitle={t.subtitle}
                    selected={activeTool?.game === game.id && activeTool?.tool === t.id}
                    onClick={() => onOpenTool(game.id, t.id)} />
                );
              })}
            </div>
            <div className="mx-2 pt-3 border-t border-specter-border-divider">
              <Toggle label="I play this" description="Saves it to your account's list of games."
                checked={Boolean(myGames?.includes(game.id))} disabled={myGames === null}
                onChange={(on) => toggleMine(game.id, on)} />
              {mineError && <Alert variant="error" className="mt-2">{mineError}</Alert>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
