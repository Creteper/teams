/**
 * TeAms LOGO（E 版：黑底两张拟态脸）。图标文件在 public/icons/（由仓库外 teams-assets/logo/make-icons.py 生成）。
 * 源图是带圆角的黑色方块、四角纯黑：显示时按圆角裁掉，深色界面上不露黑色直角。
 */
export function Logo({ size = 48, className = "" }: { size?: number; className?: string }) {
  const src = size * 2 <= 192 ? "/icons/icon-192.png" : "/icons/icon-512.png";
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt="TeAms"
      data-testid="teams-logo"
      className={`rounded-[23%] select-none ${className}`}
      draggable={false}
    />
  );
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
