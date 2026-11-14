/** TeAms LOGO（public/logo.svg）；小于 40px 时用简化版 favicon.svg，小尺寸更清楚 */
export function Logo({ size = 48, className = "" }: { size?: number; className?: string }) {
  const src = size < 40 ? "/favicon.svg" : "/logo.svg";
  return <img src={src} width={size} height={size} alt="TeAms" className={`select-none ${className}`} draggable={false} />;
}

/** LOGO + 文字标 */
export function LogoWordmark({ size = 32 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Logo size={size} />
      <span className="text-lg font-extrabold tracking-tight text-white">
        Te<span className="text-[#8ea1ff]">A</span>ms
      </span>
    </span>
  );
}
