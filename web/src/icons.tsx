/** 轻量统一的 16x16 线性 SVG 图标库（Lucide / Feather 风格） */

export function IconFolder({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 4.2A1.2 1.2 0 0 1 3.2 3h3.1l1.4 1.6h5.1A1.2 1.2 0 0 1 14 5.8v6A1.2 1.2 0 0 1 12.8 13H3.2A1.2 1.2 0 0 1 2 11.8V4.2Z" />
    </svg>
  );
}

export function IconFolderOpen({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 4.2A1.2 1.2 0 0 1 3.2 3h2.9l1.3 1.5h5.4A1.2 1.2 0 0 1 14 5.7V7H4.2L2.3 12.2A1 1 0 0 1 2 11.5V4.2Z" />
      <path d="M4.2 7h10.3l-1.6 5.2a1 1 0 0 1-1 .8H2.8a.8.8 0 0 1-.76-1.05L4.2 7Z" />
    </svg>
  );
}

export function IconFileCode({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9.5 2H4.2A1.2 1.2 0 0 0 3 3.2v9.6A1.2 1.2 0 0 0 4.2 14h7.6a1.2 1.2 0 0 0 1.2-1.2V5.5L9.5 2Z" />
      <polyline points="9.2,2 9.2,5.8 13,5.8" />
    </svg>
  );
}

export function IconOverview({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2.2" y="2.2" width="5" height="5" rx="1" />
      <rect x="8.8" y="2.2" width="5" height="5" rx="1" />
      <rect x="2.2" y="8.8" width="5" height="5" rx="1" />
      <rect x="8.8" y="8.8" width="5" height="5" rx="1" />
    </svg>
  );
}

export function IconCode({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="5.2,4.5 2,8 5.2,11.5" />
      <polyline points="10.8,4.5 14,8 10.8,11.5" />
      <line x1="9.2" y1="3.2" x2="6.8" y2="12.8" />
    </svg>
  );
}

export function IconPlus({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
      <line x1="8" y1="3.2" x2="8" y2="12.8" />
      <line x1="3.2" y1="8" x2="12.8" y2="8" />
    </svg>
  );
}

export function IconRefresh({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.4-3.7" />
      <polyline points="13.5,2.4 13.5,5.4 10.5,5.4" />
    </svg>
  );
}

export function IconTrash({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="2.8" y1="4.2" x2="13.2" y2="4.2" />
      <path d="M5.8 4.2V2.9a.9.9 0 0 1 .9-.9h2.6a.9.9 0 0 1 .9.9v1.3" />
      <path d="M4 4.2l.6 8.6a1.2 1.2 0 0 0 1.2 1.1h4.4a1.2 1.2 0 0 0 1.2-1.1L12 4.2" />
    </svg>
  );
}

export function IconSearch({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
      <circle cx="7.2" cy="7.2" r="4.4" />
      <line x1="10.5" y1="10.5" x2="13.6" y2="13.6" />
    </svg>
  );
}

export function IconSparkles({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 2l1.3 3.7L13 7l-3.7 1.3L8 12 6.7 8.3 3 7l3.7-1.3L8 2Z" />
      <path d="M12.8 11.2l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5.5-1.3Z" />
    </svg>
  );
}

export function IconCheck({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="3.2,8.4 6.5,11.6 12.8,4.6" />
    </svg>
  );
}

export function IconSend({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="13.8" y1="2.2" x2="7.2" y2="8.8" />
      <polygon points="13.8,2.2 9.5,13.8 7.2,8.8 2.2,6.5" />
    </svg>
  );
}
