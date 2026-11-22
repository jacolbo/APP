export const HeartIcon = ({ filled }: { filled: boolean }) => (
  <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
    <path
      d="M12 20.6s-7.6-4.6-9.4-9.2C1.4 8.2 3.4 4.8 6.9 4.6c2.1-.1 3.6 1 5.1 2.9 1.5-1.9 3-3 5.1-2.9 3.5.2 5.5 3.6 4.3 6.8-1.8 4.6-9.4 9.2-9.4 9.2z"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
);

export const StarIcon = ({ filled }: { filled: boolean }) => (
  <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
    <path
      d="M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />
  </svg>
);

export const ChevronIcon = ({ dir }: { dir: 'left' | 'right' }) => (
  <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
    <path d={dir === 'left' ? 'M15 4l-8 8 8 8' : 'M9 4l8 8-8 8'} fill="none" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

export const CloseIcon = () => (
  <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden="true">
    <path d="M5 5l14 14M19 5L5 19" fill="none" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);
