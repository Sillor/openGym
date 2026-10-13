// A ring that fills clockwise from twelve o'clock, the way Activity rings do. Past 100% it stays
// full; `over` paints it in the warning colour instead. Whatever sits in the middle is children.

export default function ProgressRing({ pct = 0, size = 56, stroke = 6, color = 'var(--acc)', over = false, children, className = '' }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const p = Math.max(0, Math.min(1, Number(pct) || 0))
  return (
    <span className={'fd-ring ' + className} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--fd-track)" strokeWidth={stroke} />
        <circle
          className="fd-ring-arc"
          cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={over ? 'var(--red)' : color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - p)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={p === 0 ? { opacity: 0 } : undefined}
        />
      </svg>
      {children != null && <span className="fd-ring-mid">{children}</span>}
    </span>
  )
}
