import { useEffect, useState } from "react";

// Product thumbnail with a fixed size. A missing, expired, blocked or broken
// image shows the SKU-prefix placeholder instead, in the same box, so nothing
// around it moves when an image loads or fails.
export function Thumb({ src, sku, title, size, radius, fontSize, colour, dim }: {
  src?: string | null; sku: string; title: string; size: number; radius: number;
  fontSize: number; colour: { bg: string; text: string }; dim?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  const box = { width: size, height: size, borderRadius: radius, flexShrink: 0, display: "block" } as const;
  if (src && !failed) {
    return (
      <img
        src={src}
        alt={sku ? `${sku} — ${title}` : title}
        width={size}
        height={size}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        style={{ ...box, objectFit: "cover", opacity: dim ? 0.5 : 1 }}
      />
    );
  }
  return (
    <div role="img" aria-label={sku ? `${sku} — ${title} (no photo)` : `${title} (no photo)`}
      style={{ ...box, background: colour.bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize, fontWeight: 700, color: colour.text }}>
      {sku ? sku.substring(0, 2) : "?"}
    </div>
  );
}
