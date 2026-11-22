import { useEffect } from 'react';
import { imgUrl, type Photo, type Pick } from '../api';
import { CloseIcon, HeartIcon } from '../icons';
import { Stars } from './Stars';

interface Props {
  token: string;
  a: Photo;
  b: Photo;
  pickOf: (name: string) => Pick;
  locked: boolean;
  onToggle: (name: string) => void;
  onRate: (name: string, stars: number) => void;
  onClose: () => void;
}

export function Compare({ token, a, b, pickOf, locked, onToggle, onRate, onClose }: Props) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  return (
    <div className="viewer compare" role="dialog" aria-modal="true" aria-label="Compare two photos">
      <div className="viewer-top">
        <span className="viewer-count">Compare</span>
        <button className="icon-btn light" onClick={onClose} aria-label="Close">
          <CloseIcon />
        </button>
      </div>
      <div className="compare-panes">
        {[a, b].map((p) => {
          const k = pickOf(p.name);
          return (
            <div className="compare-pane" key={p.name}>
              <div className="compare-img">
                <img
                  src={imgUrl(token, 'preview', p)}
                  style={{ backgroundImage: `url("${imgUrl(token, 'thumb', p)}")` }}
                  alt={p.name}
                  draggable={false}
                />
              </div>
              <div className="viewer-bottom">
                <Stars value={k.stars} onChange={(s) => onRate(p.name, s)} disabled={locked} />
                <button
                  className={`heart big ${k.selected ? 'on' : ''}`}
                  onClick={() => onToggle(p.name)}
                  disabled={locked}
                  aria-pressed={k.selected}
                  aria-label={k.selected ? 'Unselect' : 'Select'}
                >
                  <HeartIcon filled={k.selected} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
