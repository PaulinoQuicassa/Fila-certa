export function AuthLoading({ label = 'A carregar…' }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        background: 'var(--fc-bg)',
        color: 'var(--fc-text-secondary)',
      }}
    >
      <div className="fc-skeleton" style={{ width: 220, height: 18 }} />
      <div className="fc-skeleton" style={{ width: 148, height: 14 }} />
      <div style={{ fontSize: 14, fontWeight: 600 }}>{label}</div>
    </div>
  );
}
