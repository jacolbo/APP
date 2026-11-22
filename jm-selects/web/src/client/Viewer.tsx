import { useEffect, useRef, useState } from 'react';
import { imgUrl, type Photo, type Pick } from '../api';
import { ChevronIcon, CloseIcon, HeartIcon } from '../icons';
import { Stars } from './Stars';

interface Props {
  token: string;
  photos: Photo[];
  start: string;
  pickOf: (name: string) => Pick;
  locked: boolean;
  onToggle: (name: string) => void;
  onRate: (name: string, stars: number) => void;
  onClose: () => void;
  onCompare: (name: string) => void;
}

export function Viewer({ token, photos, start, pickOf, locked, onToggle, onRate, onClose, onCompare }: Props) {
  const [index, setIndex] = useState(() => Math.max(0, photos.findIndex((p) => p.name === start)));
  const [dx, setDx] = useState(0);
  const touch = useRef<{ x: number; y: number; t: number } | null>(null);
  const i = Math.min(index, photos.length - 1);
  const photo = photos[i];

  const go = (d: number) => setIndex((n) => Math.min(photos.length - 1, Math.max(0, n + d)));

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'Escape') onClose();
      else if (e.key === ' ' && photo) {
        e.preventDefault();
        onToggle(photo.name);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  // Preload neighbours so swiping feels instant.
  useEffect(() => {
    for (const d of [1, -1, 2]) {
      const p = photos[i + d];
      if (p) new Image().src = imgUrl(token, 'preview', p);
    }
  }, [i, photos, token]);

  if (!photo) return null;
  const k = pickOf(photo.name);

  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (!touch.current || e.touches.length !== 1) return;
    const mx = e.touches[0].clientX - touch.current.x;
    const my = e.touches[0].clientY - touch.current.y;
    if (Math.abs(mx) > Math.abs(my)) setDx(mx);
  };
  const onTouchEnd = () => {
    if (!touch.current) return;
    const fast = Date.now() - touch.current.t < 300;
    const threshold = fast ? 30 : window.innerWidth * 0.18;
    if (dx < -threshold) go(1);
    else if (dx > threshold) go(-1);
    setDx(0);
    touch.current = null;
  };

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label="Photo viewer">
      <div className="viewer-top">
        <span className="viewer-count">
          {i + 1} / {photos.length}
        </span>
        <button className="btn ghost light small" onClick={() => onCompare(photo.name)}>
          Compare with…
        </button>
        <button className="icon-btn light" onClick={onClose} aria-label="Close">
          <CloseIcon />
        </button>
      </div>

      <div
        className="viewer-stage"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        <img
          key={photo.name}
          className="viewer-img"
          src={imgUrl(token, 'preview', photo)}
          style={{
            transform: dx ? `translateX(${dx}px)` : undefined,
            backgroundImage: `url("${imgUrl(token, 'thumb', photo)}")`,
          }}
          alt={photo.name}
          draggable={false}
          onDoubleClick={() => onToggle(photo.name)}
        />
        {i > 0 && (
          <button className="nav-btn left" onClick={() => go(-1)} aria-label="Previous photo">
            <ChevronIcon dir="left" />
          </button>
        )}
        {i < photos.length - 1 && (
          <button className="nav-btn right" onClick={() => go(1)} aria-label="Next photo">
            <ChevronIcon dir="right" />
          </button>
        )}
      </div>

      <div className="viewer-bottom">
        <Stars value={k.stars} onChange={(s) => onRate(photo.name, s)} disabled={locked} />
        <button
          className={`heart big ${k.selected ? 'on' : ''}`}
          onClick={() => onToggle(photo.name)}
          disabled={locked}
          aria-pressed={k.selected}
          aria-label={k.selected ? 'Unselect' : 'Select'}
        >
          <HeartIcon filled={k.selected} />
        </button>
      </div>
    </div>
  );
}
