import type { ReactNode } from "react";
import { Card } from "@heroui/react";

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-[#313338] bg-[radial-gradient(circle_at_20%_20%,#5865f233,transparent_40%),radial-gradient(circle_at_80%_80%,#eb459e22,transparent_40%)] p-6">
      <Card className="w-full max-w-md bg-[#2b2d31] p-2">
        <Card.Header className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#5865f2] font-black text-white">TA</div>
          <Card.Title className="text-2xl">{title}</Card.Title>
          <Card.Description>{subtitle}</Card.Description>
        </Card.Header>
        <Card.Content>{children}</Card.Content>
      </Card>
    </div>
  );
}
