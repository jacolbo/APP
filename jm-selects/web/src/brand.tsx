/** The Jepson Myles wordmark, as on jepsonmyles.co.za. */
export function Brand({ large = false, sub = 'Photography Sandton' }: { large?: boolean; sub?: string }) {
  return (
    <span className={`brand ${large ? 'brand--lg' : ''}`}>
      Jepson Myles
      <span>{sub}</span>
    </span>
  );
}
